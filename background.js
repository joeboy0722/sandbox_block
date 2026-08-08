// background.js - 沙盒虛擬瀏覽器服務工作者 (Service Worker)

// 動態 Content Script 唯一識別碼
const DYNAMIC_SCRIPT_ID = "sandbox_bridge_script";

// 記憶全域已授權子框架 URL 與單次普通開啟白名單
const allowedSubframeUrls = new Set();
const allowedDirectUrls = new Set();

// 取得不重複的動態 DNR 規則 ID
async function getUniqueDnrRuleId() {
  try {
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const maxId = existingRules.reduce((max, r) => Math.max(max, r.id), 2000);
    return maxId + 1;
  } catch (e) {
    return Math.floor(Date.now() % 100000) + 2000;
  }
}

// 動態新增 DNR 網絡層阻斷規則
async function blockSubframeUrlDnr(url) {
  try {
    const ruleId = await getUniqueDnrRuleId();
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [{
        id: ruleId,
        priority: 50,
        action: { type: "block" },
        condition: {
          urlFilter: url,
          resourceTypes: ["sub_frame"]
        }
      }]
    });
  } catch (e) {
    console.error("DNR 阻斷規則新增失敗:", e);
  }
}

// 動態新增 DNR 網絡層放行規則
async function allowSubframeUrlDnr(url) {
  try {
    const ruleId = await getUniqueDnrRuleId();
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [{
        id: ruleId,
        priority: 100,
        action: { type: "allow" },
        condition: {
          urlFilter: url,
          resourceTypes: ["sub_frame"]
        }
      }]
    });
  } catch (e) {
    console.error("DNR 放行規則新增失敗:", e);
  }
}

// 清除所有動態 DNR 阻斷與標頭規則
async function clearAllDnrRules() {
  try {
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const ruleIds = existingRules.map(r => r.id);
    if (ruleIds.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: ruleIds
      });
    }
  } catch (e) {
    console.error("清除 DNR 規則失敗:", e);
  }
}

// 初始化動態 Header 解封規則 (徹底抹除 X-Frame-Options 與 CSP 防嵌入標頭)
async function updateFrameHeaderRules() {
  try {
    const rules = [
      {
        id: 1,
        priority: 1000,
        action: {
          type: "modifyHeaders",
          responseHeaders: [
            { header: "x-frame-options", operation: "remove" },
            { header: "X-Frame-Options", operation: "remove" },
            { header: "content-security-policy", operation: "remove" },
            { header: "Content-Security-Policy", operation: "remove" },
            { header: "frame-options", operation: "remove" },
            { header: "Frame-Options", operation: "remove" }
          ]
        },
        condition: {
          urlFilter: "*",
          resourceTypes: ["sub_frame", "main_frame", "xmlhttprequest", "other"]
        }
      }
    ];

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1],
      addRules: rules
    });
    console.log("🛡️ 沙盒標頭解封動態規則 (High Priority 1000) 更新成功");
  } catch (error) {
    console.error("更新動態 Header 規則失敗:", error);
  }
}

// 全域同步互斥鎖，避免 Service Worker 啟動與事件觸發時的併發競爭
let syncInProgress = null;

// 根據總開關 enabled 狀態動態同步 Content Script 注入與 DNR 規則
async function syncExtensionState(enabled) {
  if (syncInProgress) {
    try { await syncInProgress; } catch (e) {}
  }

  syncInProgress = (async () => {
    if (enabled) {
      // 1. 動態註冊 Content Script (若尚未註冊)
      try {
        const registeredScripts = await chrome.scripting.getRegisteredContentScripts();
        const isRegistered = registeredScripts.some(s => s.id === DYNAMIC_SCRIPT_ID);
        if (!isRegistered) {
          await chrome.scripting.registerContentScripts([{
            id: DYNAMIC_SCRIPT_ID,
            matches: ["<all_urls>"],
            js: ["sandbox_bridge.js"],
            runAt: "document_start",
            allFrames: true,
            world: "MAIN"
          }]);
          console.log("🛡️ [Background] 已動態註冊 sandbox_bridge.js Content Script");
        }
      } catch (e) {
        if (e && e.message && e.message.includes("Duplicate script ID")) {
          console.log("ℹ️ [Background] Content Script 已經處於註冊狀態");
        } else {
          console.error("動態註冊 Content Script 失敗:", e);
        }
      }

      // 2. 啟用 DNR 解封標頭規則
      await updateFrameHeaderRules();
    } else {
      // 1. 動態取消註冊 Content Script (開關關閉時 JS 徹底不注入)
      try {
        const registeredScripts = await chrome.scripting.getRegisteredContentScripts();
        const isRegistered = registeredScripts.some(s => s.id === DYNAMIC_SCRIPT_ID);
        if (isRegistered) {
          await chrome.scripting.unregisterContentScripts({ ids: [DYNAMIC_SCRIPT_ID] });
          console.log("🚫 [Background] 已取消註冊 sandbox_bridge.js (開關關閉，完全不注入 JS)");
        }
      } catch (e) {
        console.error("取消註冊 Content Script 失敗:", e);
      }

      // 2. 清除所有 DNR 規則
      await clearAllDnrRules();
    }
  })();

  try {
    await syncInProgress;
  } finally {
    syncInProgress = null;
  }
}

// 監聽設定變更事件
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === "local" && changes.enabled !== undefined) {
    syncExtensionState(changes.enabled.newValue);
  }
});

// 擴充套件安裝或更新時初始化
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["enabled", "domainRules", "blockCount"], (res) => {
    const enabled = res.enabled !== false;
    if (res.enabled === undefined) chrome.storage.local.set({ enabled: true });
    if (!res.domainRules) chrome.storage.local.set({ domainRules: {} });
    if (res.blockCount === undefined) chrome.storage.local.set({ blockCount: 0 });
    syncExtensionState(enabled);
  });
});

// 啟動 Service Worker 時同步狀態
chrome.storage.local.get(["enabled"], (res) => {
  const enabled = res.enabled !== false;
  syncExtensionState(enabled);
});

// 監聽網頁導航事件 (在網頁開啟前攔截與沙盒內跳轉監測)
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  const url = details.url;
  if (!url || !url.startsWith("http")) return;

  // 全域檢查：開關關閉時完全不做任何導向與攔截
  const settings = await chrome.storage.local.get(["enabled", "domainRules"]);
  if (!settings.enabled) return;

  const viewerUrl = chrome.runtime.getURL("viewer.html");

  // 1. 若最上層頁面導向外部網頁 (frameId === 0)
  if (details.frameId === 0) {
    // 若已經在 Viewer 頁面內，不再次攔截
    if (url.startsWith(viewerUrl)) return;

    // 若該 URL 在單次普通開啟白名單中，放行並移除該紀錄
    if (allowedDirectUrls.has(url)) {
      allowedDirectUrls.delete(url);
      return;
    }

    try {
      const hostname = new URL(url).hostname;
      const domainRules = settings.domainRules || {};
      const userChoice = domainRules[hostname];

      // 如果設定「總是普通開啟」，放行
      if (userChoice === "direct") return;

      const targetMode = userChoice === "sandbox" ? "sandbox" : "prompt";
      const redirectUrl = `${viewerUrl}?url=${encodeURIComponent(url)}&mode=${targetMode}`;

      chrome.tabs.update(details.tabId, { url: redirectUrl });
    } catch (e) {
      console.error("頂層導航攔截處理異常:", e);
    }
  } 
  // 2. 若為沙盒內 iframe 觸發子框架跳轉 (frameId !== 0)
  else {
    try {
      const tab = await chrome.tabs.get(details.tabId);
      if (tab && tab.url && tab.url.startsWith(viewerUrl)) {
        // 解析目前沙盒主頁面的 hostname
        let mainHost = "";
        try {
          const tabUrlObj = new URL(tab.url);
          const rawInnerUrl = tabUrlObj.searchParams.get("url");
          if (rawInnerUrl) mainHost = new URL(rawInnerUrl).hostname;
        } catch (e) {}

        let navHost = "";
        try {
          navHost = new URL(url).hostname;
        } catch (e) {}

        // 如果是同網域 (Same-origin) 跳轉，屬正常瀏覽操作，直接放行並同步更新網址列
        if (mainHost && navHost && mainHost === navHost) {
          chrome.tabs.sendMessage(details.tabId, {
            type: "UPDATE_SANDBOX_URL",
            url: url
          });
          return;
        }

        // 如果該 URL 或網域已被使用者授權過，放行
        if (allowedSubframeUrls.has(url) || (navHost && allowedSubframeUrls.has(navHost))) {
          return;
        }

        // 跨網域/未授權跳轉：立即加入 DNR 阻斷規則並發送 Toast 詢問
        await blockSubframeUrlDnr(url);

        // 發送訊息給 Viewer 視窗彈出跳轉詢問 Toast
        chrome.tabs.sendMessage(details.tabId, {
          type: "SUBFRAME_NAVIGATION_ATTEMPT",
          targetUrl: url,
          frameId: details.frameId
        });
      }
    } catch (e) {
      // 忽略標題無法取得等常規例外
    }
  }
});

// 監聽來自 Viewer 與 Bridge 的訊息與授權指令
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "INCREMENT_BLOCK_COUNT") {
    chrome.storage.local.get(["blockCount"], (res) => {
      const current = res.blockCount || 0;
      chrome.storage.local.set({ blockCount: current + 1 });
    });
  } else if (message.type === "ALLOW_SUBFRAME_URL") {
    if (message.url) {
      allowedSubframeUrls.add(message.url);
      allowSubframeUrlDnr(message.url);
    }
  } else if (message.type === "ALLOW_DIRECT_ONCE") {
    if (message.url) {
      allowedDirectUrls.add(message.url);
    }
    sendResponse({ success: true });
  }
});

