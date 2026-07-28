// viewer.js - 沙盒虛擬瀏覽器前端邏輯控制

document.addEventListener("DOMContentLoaded", () => {
  // 0. 防禦機制：鎖死 Viewport DOM (viewer.html)，自動抹除任何嘗試逃逸沙盒並掛載至 Viewport 最頂層的廣告 Frame/彈窗
  const allowedViewerElements = new Set([
    "navbar", "urlInput", "btnBack", "btnForward", "btnReload", "securityBadge",
    "viewport-container", "sandboxFrame", "promptOverlay", "toastBanner", "viewerContextMenu",
    "targetUrlBox", "btnOpenSandbox", "btnOpenDirect", "chkRemember", "toastUrl",
    "btnToastAllow", "btnToastTab", "btnToastDeny", "nav-buttons", "url-bar-container"
  ]);

  const viewportEscapeGuard = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const isAllowed = allowedViewerElements.has(node.id) ||
            allowedViewerElements.has(node.className) ||
            node.tagName === "SCRIPT" || node.tagName === "LINK" ||
            (node.parentElement && allowedViewerElements.has(node.parentElement.id));
          if (!isAllowed) {
            console.warn("🛡️ 沙盒防護：偵測到外來廣告視窗嘗試逃逸沙盒並掛載至 Viewport 最頂層，已強制抹除！", node);
            try { node.remove(); } catch (e) { }
          }
        }
      });
    });
  });

  if (document.body) {
    viewportEscapeGuard.observe(document.body, { childList: true, subtree: false });
  }

  // DOM 元素引用
  const urlInput = document.getElementById("urlInput");
  const btnBack = document.getElementById("btnBack");
  const btnForward = document.getElementById("btnForward");
  const btnReload = document.getElementById("btnReload");
  const securityBadge = document.getElementById("securityBadge");

  const sandboxFrame = document.getElementById("sandboxFrame");
  const promptOverlay = document.getElementById("promptOverlay");
  const targetUrlBox = document.getElementById("targetUrlBox");
  const btnOpenSandbox = document.getElementById("btnOpenSandbox");
  const btnOpenDirect = document.getElementById("btnOpenDirect");
  const chkRemember = document.getElementById("chkRemember");
  const toastBanner = document.getElementById("toastBanner");
  const toastUrl = document.getElementById("toastUrl");
  const toastCountBadge = document.getElementById("toastCountBadge");
  const btnToastAllow = document.getElementById("btnToastAllow");
  const btnToastTab = document.getElementById("btnToastTab");
  const btnToastDeny = document.getElementById("btnToastDeny");
  const btnToastDenyAll = document.getElementById("btnToastDenyAll");

  let currentTargetUrl = "";
  let pendingActionUrl = "";
  // 併發請求佇列 (Interception Queue System)
  const interceptionQueue = [];

  // 解析 URL 傳遞參數 (?url=...&mode=...)
  const urlParams = new URLSearchParams(window.location.search);
  const rawUrl = urlParams.get("url");
  const mode = urlParams.get("mode") || "prompt";

  if (rawUrl) {
    currentTargetUrl = decodeURIComponent(rawUrl);
    targetUrlBox.textContent = currentTargetUrl;
    urlInput.value = currentTargetUrl;
  }

  // 1. 初始化頁面載入模式
  if (mode === "sandbox") {
    loadInSandbox(currentTargetUrl);
  } else if (mode === "direct") {
    openDirectly(currentTargetUrl);
  } else {
    // 預設呈現開啟前詢問 Overlay
    promptOverlay.classList.add("active");
  }

  // 2. 開啟前對話框按鈕事件處理
  btnOpenSandbox.addEventListener("click", () => {
    saveDomainChoiceIfChecked(currentTargetUrl, "sandbox");
    promptOverlay.classList.remove("active");
    loadInSandbox(currentTargetUrl);
  });

  btnOpenDirect.addEventListener("click", () => {
    saveDomainChoiceIfChecked(currentTargetUrl, "direct");
    openDirectly(currentTargetUrl);
  });

  // 以普通網頁開啟（發送單次白名單授權給背景）
  function openDirectly(url) {
    if (!url) return;
    chrome.runtime.sendMessage({ type: "ALLOW_DIRECT_ONCE", url: url }, () => {
      window.location.href = url;
    });
  }

  // 記憶使用者對網域的處置偏好
  function saveDomainChoiceIfChecked(url, choice) {
    if (!chkRemember.checked) return;
    try {
      const hostname = new URL(url).hostname;
      chrome.storage.local.get(["domainRules"], (res) => {
        const rules = res.domainRules || {};
        rules[hostname] = choice;
        chrome.storage.local.set({ domainRules: rules });
        console.log(`已記憶網域偏好: ${hostname} -> ${choice}`);
      });
    } catch (e) {
      console.error("網域解析失敗:", e);
    }
  }

  // 3. 載入網頁至沙盒 iframe 中
  function loadInSandbox(url) {
    if (!url) return;
    urlInput.value = url;
    sandboxFrame.src = url;
    securityBadge.innerHTML = "<span>🛡️ 沙盒防護中 (100% 封鎖彈窗)</span>";
    securityBadge.classList.remove("disabled");
  }

  // 將攔截請求推入佇列系統
  function triggerInterceptionToast(url, actionType) {
    let displayUrl = url;
    if (!displayUrl || displayUrl === "about:blank") {
      if (actionType === "POPUP_WINDOW") {
        displayUrl = "彈出新視窗 (等待載入網址)";
      } else {
        return;
      }
    }

    // 防止完全重複的請求重複推入佇列洗版
    const isDuplicate = interceptionQueue.some(item => item.url === displayUrl && item.actionType === actionType);
    if (!isDuplicate) {
      interceptionQueue.push({
        url: displayUrl,
        actionType: actionType,
        timestamp: Date.now()
      });
      // 觸發背景攔截計數累加
      chrome.runtime.sendMessage({ type: "INCREMENT_BLOCK_COUNT" });
    }

    processInterceptionQueue();
  }

  // 處理與展現佇列頂部的攔截請求 UI
  function processInterceptionQueue() {
    if (interceptionQueue.length === 0) {
      toastBanner.classList.remove("show");
      if (toastCountBadge) toastCountBadge.style.display = "none";
      return;
    }

    const current = interceptionQueue[0];
    const toastTitleEl = document.querySelector(".toast-title span");
    if (toastTitleEl) {
      if (current.actionType === "POPUP_WINDOW" || current.actionType === "LINK_BLANK") {
        toastTitleEl.textContent = "⚠️ 偵測到彈出視窗 (Popup) 請求";
      } else {
        toastTitleEl.textContent = "⚠️ 偵測到網頁跳轉請求";
      }
    }

    if (toastCountBadge) {
      toastCountBadge.textContent = `(${interceptionQueue.length} 個未處置)`;
      toastCountBadge.style.display = interceptionQueue.length > 1 ? "inline-block" : "none";
    }

    pendingActionUrl = current.url;
    toastUrl.textContent = current.url;
    toastBanner.classList.add("show");
  }

  // 4. 網址列手動輸入導向
  urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    let inputUrl = urlInput.value.trim();
    if (!inputUrl.startsWith("http://") && !inputUrl.startsWith("https://")) {
      inputUrl = "https://" + inputUrl;
    }
    currentTargetUrl = inputUrl;
    loadInSandbox(currentTargetUrl);
  }
});

// 5. 導航按鈕處理
btnReload.addEventListener("click", () => {
  if (sandboxFrame.src) {
    sandboxFrame.src = sandboxFrame.src;
  }
});

btnBack.addEventListener("click", () => {
  try {
    sandboxFrame.contentWindow.history.back();
  } catch (e) {
    console.log("Cross-origin history navigation restricted");
  }
});

btnForward.addEventListener("click", () => {
  try {
    sandboxFrame.contentWindow.history.forward();
  } catch (e) {
    console.log("Cross-origin history navigation restricted");
  }
});

// 6. 監聽來自沙盒內部 Bridge 的 postMessage 訊息 (window.open, location.href, 連結點擊, 黑名單請求)
window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data) return;

  if (data.type === "SANDBOX_INTERCEPTED_ACTION") {
    console.log("收到沙盒內攔截事件:", data);
    triggerInterceptionToast(data.targetUrl, data.actionType);
  } else if (data.type === "ADD_ELEMENT_TO_BLACKLIST") {
    const { hostname, selector } = data;
    if (!hostname || !selector) return;
    chrome.storage.local.get(["elementBlacklist"], (res) => {
      const blacklist = res.elementBlacklist || {};
      const siteList = blacklist[hostname] || [];
      if (!siteList.includes(selector)) {
        siteList.push(selector);
        blacklist[hostname] = siteList;
        chrome.storage.local.set({ elementBlacklist: blacklist }, () => {
          console.log(`已將元素選擇器新增至網域黑名單 [${hostname}]:`, selector);
          notifySandboxBlacklist(hostname, siteList);
        });
      }
    });
  } else if (data.type === "REQUEST_ELEMENT_BLACKLIST") {
    const { hostname } = data;
    if (!hostname) return;
    chrome.storage.local.get(["elementBlacklist"], (res) => {
      const blacklist = res.elementBlacklist || {};
      const siteList = blacklist[hostname] || [];
      notifySandboxBlacklist(hostname, siteList);
    });
  } else if (data.type === "SHOW_VIEWER_CONTEXT_MENU") {
    renderTopViewerContextMenu(data);
  } else if (data.type === "UPDATE_VIEWER_METADATA") {
    updateViewerTabTitleAndFavicon(data.title, data.faviconUrl);
  }
});

// 8.5 動態同步 Viewport 分頁 Title (加上 (沙盒) 尾綴) 與 Favicon
function updateViewerTabTitleAndFavicon(title, faviconUrl) {
  if (title && title !== "沙盒虛擬瀏覽器") {
    const cleanTitle = title.trim();
    document.title = `${cleanTitle} (沙盒)`;
  }

  if (faviconUrl) {
    let favEl = document.getElementById("viewerFavicon");
    if (!favEl) {
      favEl = document.createElement("link");
      favEl.id = "viewerFavicon";
      favEl.rel = "icon";
      document.head.appendChild(favEl);
    }
    favEl.href = faviconUrl;
  }
}

// 9. 在 viewer.html 最上層繪製右鍵選單 (100% 壓過沙盒內任何廣告與 z-index)
const viewerContextMenu = document.getElementById("viewerContextMenu");
let viewerContextMenuOpenTime = 0;
let keepTopmostInterval = null;

function startKeepContextMenuOnTop() {
  stopKeepContextMenuOnTop();
  keepTopmostInterval = setInterval(() => {
    if (viewerContextMenu && viewerContextMenu.style.display !== "none") {
      if (document.body && document.body.lastElementChild !== viewerContextMenu) {
        document.body.appendChild(viewerContextMenu);
      }
    } else {
      stopKeepContextMenuOnTop();
    }
  }, 50);
}

function stopKeepContextMenuOnTop() {
  if (keepTopmostInterval) {
    clearInterval(keepTopmostInterval);
    keepTopmostInterval = null;
  }
}

function hideViewerContextMenu() {
  // 防止右鍵按下並放開時連帶產生的 click/pointerup 事件瞬間誤關選單
  if (Date.now() - viewerContextMenuOpenTime < 300) return;
  forceHideViewerContextMenu();
}

function forceHideViewerContextMenu() {
  stopKeepContextMenuOnTop();
  if (viewerContextMenu) {
    viewerContextMenu.style.display = "none";
  }
}

window.addEventListener("click", (e) => {
  if (e.button === 0) hideViewerContextMenu();
});
window.addEventListener("scroll", hideViewerContextMenu, true);
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") forceHideViewerContextMenu();
});

function renderTopViewerContextMenu(data) {
  if (!viewerContextMenu) return;
  if (document.body && document.body.lastElementChild !== viewerContextMenu) {
    document.body.appendChild(viewerContextMenu);
  }
  viewerContextMenu.innerHTML = "";

  const items = data.menuItems || [];
  if (items.length === 0) return;

  viewerContextMenuOpenTime = Date.now();

  items.forEach((itemData) => {
    const item = document.createElement("div");
    item.className = `viewer-context-menu-item ${itemData.danger ? "danger" : "normal"}`;
    item.textContent = itemData.label;

    item.addEventListener("click", (e) => {
      e.stopPropagation();
      forceHideViewerContextMenu();
      if (itemData.selector && data.hostname) {
        saveSelectorToBlacklist(data.hostname, itemData.selector);
      }
    });

    viewerContextMenu.appendChild(item);
  });

  viewerContextMenu.style.display = "block";
  const menuWidth = viewerContextMenu.offsetWidth || 190;
  const menuHeight = viewerContextMenu.offsetHeight || 80;

  const posX = Math.min(data.clientX, window.innerWidth - menuWidth - 10);
  const posY = Math.min(data.clientY, window.innerHeight - menuHeight - 10);

  viewerContextMenu.style.left = Math.max(5, posX) + "px";
  viewerContextMenu.style.top = Math.max(5, posY) + "px";

  // 啟動 50ms 長輪詢持續置頂校正
  startKeepContextMenuOnTop();
}

function saveSelectorToBlacklist(hostname, selector) {
  if (!hostname || !selector) {
    console.warn("⚠️ 寫入黑名單失敗：hostname 或 selector 為空", { hostname, selector });
    return;
  }
  console.log(`🚫 [Viewport 最上層] 正在將選擇器寫入黑名單 [${hostname}]:`, selector);

  chrome.storage.local.get(["elementBlacklist"], (res) => {
    const blacklist = res.elementBlacklist || {};
    const siteList = blacklist[hostname] || [];
    if (!siteList.includes(selector)) {
      siteList.push(selector);
      blacklist[hostname] = siteList;
      chrome.storage.local.set({ elementBlacklist: blacklist }, () => {
        console.log(`✅ 已成功持久化寫入 Chrome Storage [${hostname}]:`, selector);
      });
    }
    // 無論 Storage 是否已存在，皆強制觸發沙盒 DOM 抹除通知
    notifySandboxBlacklist(hostname, siteList.includes(selector) ? siteList : [...siteList, selector]);
  });
}

// 向沙盒 Frame 發送黑名單樣式表更新訊息
function notifySandboxBlacklist(hostname, selectors) {
  if (sandboxFrame && sandboxFrame.contentWindow) {
    try {
      sandboxFrame.contentWindow.postMessage({
        type: "APPLY_ELEMENT_BLACKLIST",
        hostname: hostname,
        selectors: selectors
      }, "*");
    } catch (e) {
      console.error("發送沙盒黑名單通知失敗:", e);
    }
  }
}

// 監聽 Storage 變更 (若在 Popup 中刪除了黑名單項目，即時發送給沙盒 Frame 恢復顯示)
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === "local" && changes.elementBlacklist) {
    try {
      const targetUrl = sandboxFrame.src || currentTargetUrl;
      if (targetUrl) {
        const currentHostname = new URL(targetUrl).hostname;
        const newBlacklist = changes.elementBlacklist.newValue || {};
        const updatedList = newBlacklist[currentHostname] || [];
        notifySandboxBlacklist(currentHostname, updatedList);
      }
    } catch (e) { }
  }
});

// 7. 監聽來自 Background Service Worker 的子框架導航通知 (webNavigation)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SUBFRAME_NAVIGATION_ATTEMPT") {
    console.log("收到背景子框架導航攔截通知:", message.targetUrl);
    triggerInterceptionToast(message.targetUrl, "SUBFRAME_NAVIGATE");
  }
});

// 8. 處理 Toast 按鈕點擊動作
btnToastAllow.addEventListener("click", () => {
  const current = interceptionQueue.shift();
  const actionUrl = current ? current.url : pendingActionUrl;
  if (actionUrl) {
    chrome.runtime.sendMessage({ type: "ALLOW_SUBFRAME_URL", url: actionUrl });
    loadInSandbox(actionUrl);
  }
  processInterceptionQueue();
});

btnToastTab.addEventListener("click", () => {
  const current = interceptionQueue.shift();
  const actionUrl = current ? current.url : pendingActionUrl;
  if (actionUrl) {
    chrome.runtime.sendMessage({ type: "ALLOW_DIRECT_ONCE", url: actionUrl }, () => {
      window.open(actionUrl, "_blank");
    });
  }
  processInterceptionQueue();
});

btnToastDeny.addEventListener("click", () => {
  interceptionQueue.shift();
  processInterceptionQueue();
});

});
