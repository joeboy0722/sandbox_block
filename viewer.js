// viewer.js - 沙盒虛擬瀏覽器前端邏輯控制

document.addEventListener("DOMContentLoaded", () => {
  // 0. 防禦機制：鎖死 Viewport DOM (viewer.html)，自動抹除任何嘗試逃逸沙盒並掛載至 Viewport 最頂層的廣告 Frame/彈窗
  const allowedViewerElements = new Set([
    "navbar", "urlInput", "btnBack", "btnForward", "btnReload", "securityBadge",
    "viewport-container", "sandboxFrame", "promptOverlay", "toastBanner", "viewerContextMenu",
    "targetUrlBox", "btnOpenSandbox", "btnOpenDirect", "chkRemember", "toastUrl",
    "btnToastAllow", "btnToastTab", "btnToastDeny", "nav-buttons", "url-bar-container",
    "extractor-tools", "btnPickerMode", "btnToggleDrawer", "mediaCountBadge", "extractorDrawer",
    "mediaList", "pickerDetailModal", "btnClearMedia", "btnCloseDrawer", "countAll", "countVideo",
    "countAudio", "countImage", "countFile", "pickerModalIcon", "pickerModalTitle", "btnClosePickerModal",
    "pickerModalPreview", "pickerTagType", "pickerUrlInput", "btnCopyPickerUrl", "btnOpenPickerUrl",
    "btnDownloadPickerUrl", "picker-modal-card"
  ]);

  const viewportEscapeGuard = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const isInsideAllowedParent = !!(node.closest && node.closest("#extractorDrawer, #pickerDetailModal, #viewerContextMenu, .navbar, .viewport-container, #toastBanner, #promptOverlay"));
          const isAllowed = isInsideAllowedParent ||
            allowedViewerElements.has(node.id) ||
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
    viewportEscapeGuard.observe(document.body, { childList: true, subtree: true });
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

  // 併發請求佇列 (Interception Queue System) 與連環彈窗暴風雨防禦
  const interceptionQueue = [];
  const recentInterceptionTimestamps = [];
  let burstSuppressionCount = 0;
  let isStormModeActive = false;
  let stormResetTimer = null;

  // 將攔截請求推入佇列系統 (含連環暴風雨彈窗防禦)
  function triggerInterceptionToast(url, actionType) {
    let displayUrl = url;
    if (!displayUrl || displayUrl === "about:blank") {
      if (actionType === "POPUP_WINDOW") {
        displayUrl = "彈出新視窗 (等待載入網址)";
      } else {
        return;
      }
    }

    const now = Date.now();
    // 清理超過 1.5 秒前的時間戳記
    while (recentInterceptionTimestamps.length > 0 && now - recentInterceptionTimestamps[0] > 1500) {
      recentInterceptionTimestamps.shift();
    }
    recentInterceptionTimestamps.push(now);

    // 觸發背景攔截計數累加
    chrome.runtime.sendMessage({ type: "INCREMENT_BLOCK_COUNT" });

    // 若 1.5 秒內觸發請求數 > 3，自動進入暴風雨封鎖模式
    if (recentInterceptionTimestamps.length > 3) {
      isStormModeActive = true;
      burstSuppressionCount++;

      if (stormResetTimer) clearTimeout(stormResetTimer);
      stormResetTimer = setTimeout(() => {
        isStormModeActive = false;
        burstSuppressionCount = 0;
        processInterceptionQueue();
      }, 2500);

      // 直接靜音封鎖連環彈窗，不堆積佇列，僅更新提示標題
      processInterceptionQueue();
      return;
    }

    // 防止完全重複的請求重複推入佇列洗版
    const isDuplicate = interceptionQueue.some(item => item.url === displayUrl && item.actionType === actionType);
    if (!isDuplicate) {
      interceptionQueue.push({
        url: displayUrl,
        actionType: actionType,
        timestamp: now
      });
    }

    processInterceptionQueue();
  }

  // 處理與展現佇列頂部的攔截請求 UI
  function processInterceptionQueue() {
    if (interceptionQueue.length === 0 && !isStormModeActive) {
      toastBanner.classList.remove("show");
      if (toastCountBadge) toastCountBadge.style.display = "none";
      if (btnToastDenyAll) btnToastDenyAll.style.display = "none";
      return;
    }

    const toastTitleEl = document.querySelector(".toast-title span");

    // 暴風雨連環彈窗防禦模式 UI 展現
    if (isStormModeActive) {
      if (toastTitleEl) {
        toastTitleEl.textContent = `🛡️ 偵測到連環彈窗攻擊 (已自動批次封鎖 ${burstSuppressionCount} 個請求)`;
      }
      toastUrl.textContent = "多重跳轉/彈窗風暴已由沙盒自動攔截與批次靜音封鎖";
      if (toastCountBadge) toastCountBadge.style.display = "none";
      if (btnToastDenyAll) btnToastDenyAll.style.display = "inline-block";
      toastBanner.classList.add("show");
      return;
    }

    const current = interceptionQueue[0];
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

    if (btnToastDenyAll) {
      btnToastDenyAll.style.display = interceptionQueue.length > 1 ? "inline-block" : "none";
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
  } else if (data.type === "SANDBOX_DISCOVERED_MEDIA") {
    if (Array.isArray(data.mediaList)) {
      handleDiscoveredMediaList(data.mediaList);
    }
  } else if (data.type === "SANDBOX_ELEMENT_PICKED") {
    if (data.payload) {
      showPickerDetailModal(data.payload);
    }
  }
});

// =========================================================================
// 10. 沙盒多媒體資源提取器 (Media Extractor) 與點選探針 (Element Picker) 控制 logic
// =========================================================================

const btnPickerMode = document.getElementById("btnPickerMode");
const btnToggleDrawer = document.getElementById("btnToggleDrawer");
const mediaCountBadge = document.getElementById("mediaCountBadge");
const extractorDrawer = document.getElementById("extractorDrawer");
const btnClearMedia = document.getElementById("btnClearMedia");
const btnCloseDrawer = document.getElementById("btnCloseDrawer");
const mediaListContainer = document.getElementById("mediaList");

const countAllEl = document.getElementById("countAll");
const countVideoEl = document.getElementById("countVideo");
const countAudioEl = document.getElementById("countAudio");
const countImageEl = document.getElementById("countImage");
const countFileEl = document.getElementById("countFile");

const pickerDetailModal = document.getElementById("pickerDetailModal");
const btnClosePickerModal = document.getElementById("btnClosePickerModal");
const pickerModalTitle = document.getElementById("pickerModalTitle");
const pickerModalPreview = document.getElementById("pickerModalPreview");
const pickerTagType = document.getElementById("pickerTagType");
const pickerUrlInput = document.getElementById("pickerUrlInput");
const btnCopyPickerUrl = document.getElementById("btnCopyPickerUrl");
const btnOpenPickerUrl = document.getElementById("btnOpenPickerUrl");
const btnDownloadPickerUrl = document.getElementById("btnDownloadPickerUrl");

let isPickerActive = false;
let currentActiveTab = "all";
let discoveredMediaMap = new Map();

// A. 點擊選取模式開關
btnPickerMode.addEventListener("click", () => {
  setPickerActiveState(!isPickerActive);
});

function setPickerActiveState(active) {
  isPickerActive = !!active;
  if (isPickerActive) {
    btnPickerMode.classList.add("active");
    btnPickerMode.querySelector("span").textContent = "🎯 點選中(按ESC取消)";
  } else {
    btnPickerMode.classList.remove("active");
    btnPickerMode.querySelector("span").textContent = "🎯 點選提取";
  }

  // 發送導引通知給沙盒內部的 Bridge
  if (sandboxFrame && sandboxFrame.contentWindow) {
    try {
      sandboxFrame.contentWindow.postMessage({
        type: "TOGGLE_ELEMENT_PICKER",
        enabled: isPickerActive
      }, "*");
    } catch (e) {}
  }
}

// 按下 ESC 鍵取消選取模式
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && isPickerActive) {
    setPickerActiveState(false);
  }
});

// B. 抽屜式面板開關
btnToggleDrawer.addEventListener("click", () => {
  const isOpen = extractorDrawer.classList.toggle("open");
  console.log("📦 點擊內容提取按鈕，面板開啟狀態:", isOpen);
  if (isOpen) {
    renderMediaList();
  }
});

btnCloseDrawer.addEventListener("click", () => {
  extractorDrawer.classList.remove("open");
});

btnClearMedia.addEventListener("click", () => {
  discoveredMediaMap.clear();
  renderMediaList();
});

// C. 媒體類別 Tab 切換
const tabBtns = document.querySelectorAll(".media-tabs .tab-btn");
tabBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    tabBtns.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentActiveTab = btn.getAttribute("data-tab");
    renderMediaList();
  });
});

// D. 處理自動偵測到的媒體清單
function handleDiscoveredMediaList(newList) {
  newList.forEach((item) => {
    if (item && item.url && !discoveredMediaMap.has(item.url)) {
      discoveredMediaMap.set(item.url, item);
    }
  });
  renderMediaList();
}

// 繪製與分類媒體卡片
function renderMediaList() {
  const allItems = Array.from(discoveredMediaMap.values());
  
  // 更新計數
  const videoList = allItems.filter(i => i.type === "video");
  const audioList = allItems.filter(i => i.type === "audio");
  const imageList = allItems.filter(i => i.type === "image");
  const fileList = allItems.filter(i => i.type === "file" || !["video", "audio", "image"].includes(i.type));

  countAllEl.textContent = allItems.length;
  countVideoEl.textContent = videoList.length;
  countAudioEl.textContent = audioList.length;
  countImageEl.textContent = imageList.length;
  countFileEl.textContent = fileList.length;
  mediaCountBadge.textContent = allItems.length;

  let displayItems = allItems;
  if (currentActiveTab === "video") displayItems = videoList;
  else if (currentActiveTab === "audio") displayItems = audioList;
  else if (currentActiveTab === "image") displayItems = imageList;
  else if (currentActiveTab === "file") displayItems = fileList;

  mediaListContainer.innerHTML = "";

  if (displayItems.length === 0) {
    mediaListContainer.innerHTML = `
      <div class="empty-media-tip">
        <div class="empty-icon">🔍</div>
        <p>此類別中尚無提取到的多媒體內容</p>
        <span class="empty-sub">可點擊頂部「🎯 點選提取」直接點選網頁畫面提取影片或圖片</span>
      </div>
    `;
    return;
  }

  displayItems.forEach((item) => {
    const card = document.createElement("div");
    card.className = "media-card";

    let previewHtml = "";
    if (item.type === "image") {
      previewHtml = `<div class="media-preview-box"><img src="${item.url}" loading="lazy" alt="預覽圖" /></div>`;
    } else if (item.type === "video") {
      previewHtml = `<div class="media-preview-box"><video src="${item.url}" controls preload="metadata"></video></div>`;
    }

    card.innerHTML = `
      <div class="media-card-header">
        <span class="media-tag tag-${item.type}">${item.tag || item.type}</span>
      </div>
      <div class="media-url" title="${item.url}">${item.url}</div>
      ${previewHtml}
      <div class="media-card-actions">
        <button class="btn-sm btn-toast-tab btn-copy-url">📋 複製</button>
        <button class="btn-sm btn-toast-allow btn-open-url">🌐 開啟</button>
        <button class="btn-sm btn-toast-deny btn-download-url">⬇️ 下載</button>
      </div>
    `;

    // 複製事件
    card.querySelector(".btn-copy-url").addEventListener("click", () => {
      navigator.clipboard.writeText(item.url);
      const btn = card.querySelector(".btn-copy-url");
      btn.textContent = "✅ 已複製";
      setTimeout(() => btn.textContent = "📋 複製", 1500);
    });

    // 開啟事件
    card.querySelector(".btn-open-url").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "ALLOW_DIRECT_ONCE", url: item.url }, () => {
        window.open(item.url, "_blank");
      });
    });

    // 下載事件
    card.querySelector(".btn-download-url").addEventListener("click", () => {
      triggerDownload(item.url);
    });

    mediaListContainer.appendChild(card);
  });
}

// E. 顯示選取物件詳情 Modal
function showPickerDetailModal(payload) {
  setPickerActiveState(false);
  if (!payload || !payload.url) return;

  pickerTagType.textContent = payload.tag || payload.type.toUpperCase();
  pickerUrlInput.value = payload.url;

  pickerModalPreview.innerHTML = "";
  if (payload.imgSrc) {
    pickerModalPreview.innerHTML = `<img src="${payload.imgSrc}" alt="廣告圖檔預覽" />`;
  } else if (payload.type === "image") {
    pickerModalPreview.innerHTML = `<img src="${payload.url}" alt="點選提取圖檔" />`;
  } else if (payload.type === "video") {
    pickerModalPreview.innerHTML = `<video src="${payload.url}" controls autoplay></video>`;
  } else if (payload.text) {
    pickerModalPreview.innerHTML = `<div style="padding:16px; font-size:13px; color:#f8fafc; overflow-y:auto; max-height:160px; word-break:break-all;">${payload.text}</div>`;
  } else {
    pickerModalPreview.innerHTML = `<div style="padding:20px; color:#94a3b8;">已擷取元素鏈結內容</div>`;
  }

  pickerDetailModal.classList.add("show");
}

btnClosePickerModal.addEventListener("click", () => {
  pickerDetailModal.classList.remove("show");
});

btnCopyPickerUrl.addEventListener("click", () => {
  if (pickerUrlInput.value) {
    navigator.clipboard.writeText(pickerUrlInput.value);
    btnCopyPickerUrl.textContent = "✅ 已複製";
    setTimeout(() => btnCopyPickerUrl.textContent = "📋 複製", 1500);
  }
});

btnOpenPickerUrl.addEventListener("click", () => {
  const url = pickerUrlInput.value;
  if (url) {
    chrome.runtime.sendMessage({ type: "ALLOW_DIRECT_ONCE", url: url }, () => {
      window.open(url, "_blank");
    });
  }
});

btnDownloadPickerUrl.addEventListener("click", () => {
  const url = pickerUrlInput.value;
  if (url) {
    triggerDownload(url);
  }
});

// 通用觸發下載函式
function triggerDownload(url) {
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = url.split("/").pop().split("?")[0] || "download";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch (e) {
    window.open(url, "_blank");
  }
}

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
  } else if (message.type === "UPDATE_SANDBOX_URL") {
    if (message.url) {
      currentTargetUrl = message.url;
      urlInput.value = message.url;
    }
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

if (btnToastDenyAll) {
  btnToastDenyAll.addEventListener("click", () => {
    interceptionQueue.length = 0;
    isStormModeActive = false;
    burstSuppressionCount = 0;
    if (stormResetTimer) clearTimeout(stormResetTimer);
    processInterceptionQueue();
  });
}

});
