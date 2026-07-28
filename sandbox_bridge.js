// sandbox_bridge.js - 沙盒內部全方位跳轉與彈窗 Hook 腳本 (僅於 viewer.html 沙盒容器內生效)

(function () {
  if (window.__SANDBOX_BRIDGE_INITIALIZED__) return;

  // 1. 精準判斷當前網頁是否運行在沙盒虛擬瀏覽器 Viewport (viewer.html) 內部
  let isInsideViewerSandbox = false;
  try {
    const topHref = (window.top && window.top.location) ? window.top.location.href : "";
    // 只有當最外層視窗為 viewer.html 且模式為 sandbox 時才視為沙盒環境
    if (topHref.includes("viewer.html") && !topHref.includes("mode=direct")) {
      isInsideViewerSandbox = true;
    }
  } catch (e) {
    // 跨網域存取 window.top.location.href 拋出 security exception，代表被封裝在跨網域沙盒 iframe 內部
    isInsideViewerSandbox = true;
  }

  // 2. 若完全不在 viewer.html 沙盒視窗內（代表為普通模式/標準 Chrome 分頁開啟），直接取消 Bridge 注入！
  if (!isInsideViewerSandbox) {
    console.log("🌐 [Bridge] 當前網頁於普通模式 (標準 Chrome 分頁) 開啟，直接取消 Bridge 注入與所有攔截！");
    return;
  }

  window.__SANDBOX_BRIDGE_INITIALIZED__ = true;
  console.log("🛡️ 沙盒內部雙重防護與全方位跳轉 Bridge 已成功注入！");

  // 保存真實頂層與父視窗引用，用於安全的 postMessage 通訊
  const realTop = window.top;
  const realParent = window.parent;

  // 1. 全方位隔離與保護 window.top 與 window.parent (含原型鏈與子 iframe 保護)
  function applyWindowScopeProtection(targetWin) {
    if (!targetWin) return;
    try {
      const windowProto = Object.getPrototypeOf(targetWin) || targetWin;
      Object.defineProperty(targetWin, "top", {
        get: function () { return targetWin; },
        set: function () {},
        configurable: false,
        enumerable: true
      });
      Object.defineProperty(targetWin, "parent", {
        get: function () { return targetWin; },
        set: function () {},
        configurable: false,
        enumerable: true
      });
      if (windowProto && windowProto !== targetWin) {
        try {
          Object.defineProperty(windowProto, "top", {
            get: function () { return this; },
            configurable: false
          });
          Object.defineProperty(windowProto, "parent", {
            get: function () { return this; },
            configurable: false
          });
        } catch (e) {}
      }
    } catch (e) {}
  }

  applyWindowScopeProtection(window);

  // 攔截 HTMLIFrameElement.prototype.contentWindow 存取，保護全新子框架視窗
  try {
    const origContentWindowDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow");
    if (origContentWindowDesc && origContentWindowDesc.get) {
      Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
        get: function () {
          const childWin = origContentWindowDesc.get.call(this);
          if (childWin) {
            applyWindowScopeProtection(childWin);
          }
          return childWin;
        },
        configurable: true,
        enumerable: true
      });
    }
  } catch (e) {}

  // 攔截 Blob URL 與 srcdoc 注入逃逸嘗試
  try {
    const origCreateObjectURL = URL.createObjectURL;
    if (origCreateObjectURL) {
      URL.createObjectURL = function (blob) {
        if (blob && blob.type && blob.type.toLowerCase().includes("html")) {
          console.warn("🛡️ 沙盒防護：偵測到動態 HTML Blob 物件生成，已紀錄安全性警示");
        }
        return origCreateObjectURL.apply(this, arguments);
      };
    }

    const origSrcdocDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "srcdoc");
    if (origSrcdocDesc && origSrcdocDesc.set) {
      Object.defineProperty(HTMLIFrameElement.prototype, "srcdoc", {
        get: function () { return origSrcdocDesc.get.call(this); },
        set: function (val) {
          console.warn("🛡️ 沙盒防禦：偵測到動態 srcdoc 寫入，實施子框架安全隔離");
          return origSrcdocDesc.set.call(this, val);
        },
        configurable: true,
        enumerable: true
      });
    }
  } catch (e) {}

  // History API 限速 (防止 Back-Button Hijacking)
  try {
    let historyCallCount = 0;
    let historyResetTimer = null;
    const origPushState = history.pushState;
    const origReplaceState = history.replaceState;

    function checkHistoryRateLimit() {
      historyCallCount++;
      if (!historyResetTimer) {
        historyResetTimer = setTimeout(() => {
          historyCallCount = 0;
          historyResetTimer = null;
        }, 2000);
      }
      return historyCallCount <= 5;
    }

    if (origPushState) {
      history.pushState = function () {
        if (!checkHistoryRateLimit()) {
          console.warn("🛡️ 沙盒防禦：阻斷高頻 history.pushState (歷史紀錄劫持防護)");
          return;
        }
        return origPushState.apply(this, arguments);
      };
    }

    if (origReplaceState) {
      history.replaceState = function () {
        if (!checkHistoryRateLimit()) {
          console.warn("🛡️ 沙盒防禦：阻斷高頻 history.replaceState");
          return;
        }
        return origReplaceState.apply(this, arguments);
      };
    }
  } catch (e) {}

  // 發送訊息給外層 Viewer 視窗的通訊函式 (含頻率節流防護)
  let lastNotifyTime = 0;
  let burstNotifyCount = 0;

  function notifyParent(actionType, targetUrl) {
    try {
      const now = Date.now();
      if (now - lastNotifyTime < 300) {
        burstNotifyCount++;
      } else {
        burstNotifyCount = 0;
      }
      lastNotifyTime = now;

      let resolvedUrl = targetUrl;
      if (resolvedUrl && typeof resolvedUrl === "string") {
        if (resolvedUrl.startsWith("undefined") || resolvedUrl.includes("://undefined")) {
          resolvedUrl = window.location.href;
        } else if (!resolvedUrl.startsWith("http") && !resolvedUrl.startsWith("about:") && !resolvedUrl.startsWith("彈出")) {
          try {
            resolvedUrl = new URL(resolvedUrl, window.location.href).href;
          } catch (e) {
            resolvedUrl = targetUrl;
          }
        }
      } else if (!resolvedUrl) {
        resolvedUrl = "about:blank";
      }
      
      console.warn(`⚠️ 沙盒攔截到動作 [${actionType}]:`, resolvedUrl);

      // 透過保存的 realTop 向外層 Viewport (viewer.js) 發送廣播
      (realTop || realParent || window).postMessage({
        type: "SANDBOX_INTERCEPTED_ACTION",
        actionType: actionType,
        targetUrl: resolvedUrl,
        burstCount: burstNotifyCount
      }, "*");
    } catch (e) {
      console.error("發送攔截通知失敗:", e);
    }
  }

  // 1.5 動態同步頁面 Title 與 Favicon 給 Viewport (viewer.js)
  function sendTitleAndFavicon() {
    try {
      const title = document.title || window.location.hostname;
      let faviconUrl = "";

      const iconLink = document.querySelector('link[rel*="icon"]');
      if (iconLink && iconLink.href) {
        faviconUrl = iconLink.href;
      } else if (window.location.protocol.startsWith("http")) {
        faviconUrl = `${window.location.protocol}//${window.location.hostname}/favicon.ico`;
      }

      (realTop || realParent || window).postMessage({
        type: "UPDATE_VIEWER_METADATA",
        title: title,
        faviconUrl: faviconUrl
      }, "*");
    } catch (e) {}
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    sendTitleAndFavicon();
  } else {
    document.addEventListener("DOMContentLoaded", sendTitleAndFavicon);
    window.addEventListener("load", sendTitleAndFavicon);
  }

  try {
    const titleEl = document.querySelector("title");
    if (titleEl) {
      const titleObserver = new MutationObserver(sendTitleAndFavicon);
      titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
    }
  } catch (e) {}

  // 2. Hook window.open (攔截 JavaScript 觸發的彈窗)
  try {
    const originalOpen = window.open;
    window.open = function (url, target, features) {
      let targetUrl = url;
      notifyParent("POPUP_WINDOW", targetUrl || "about:blank");

      let currentUrl = targetUrl || "about:blank";
      const mockWin = {
        closed: false,
        focus: function () {},
        blur: function () {},
        close: function () { this.closed = true; },
        postMessage: function () {}
      };

      const locationObj = {
        assign: function (newUrl) {
          currentUrl = newUrl;
          notifyParent("POPUP_WINDOW", newUrl);
        },
        replace: function (newUrl) {
          currentUrl = newUrl;
          notifyParent("POPUP_WINDOW", newUrl);
        },
        toString: function () {
          return currentUrl;
        }
      };

      Object.defineProperty(locationObj, "href", {
        get: function () { return currentUrl; },
        set: function (newUrl) {
          currentUrl = newUrl;
          notifyParent("POPUP_WINDOW", newUrl);
        },
        configurable: true,
        enumerable: true
      });

      mockWin.location = locationObj;
      return mockWin;
    };
  } catch (e) {
    console.error("Hook window.open 失敗:", e);
  }

  // 通用跳轉攔截日誌與廣播函式
  function blockNavigation(actionType, targetUrl) {
    let resolvedUrl = targetUrl;
    if (resolvedUrl && typeof resolvedUrl === "string") {
      if (resolvedUrl.startsWith("undefined") || resolvedUrl.includes("://undefined")) {
        resolvedUrl = window.location.href;
      } else if (!resolvedUrl.startsWith("http") && !resolvedUrl.startsWith("about:") && !resolvedUrl.startsWith("彈出")) {
        try {
          resolvedUrl = new URL(resolvedUrl, window.location.href).href;
        } catch (e) {
          resolvedUrl = targetUrl;
        }
      }
    } else if (!resolvedUrl) {
      resolvedUrl = "about:blank";
    }

    console.warn(`🛡️ 沙盒防護：已成功攔截並徹底封鎖跳轉動作 [${actionType}]:`, resolvedUrl);
    notifyParent(actionType, resolvedUrl);
    return false;
  }

  // 3. 全面死封 Location 與 Window.location 屬性與方法，強效鎖死所有內部/全頁跳轉
  try {
    // (A) Hook Location.prototype.assign & replace (不執行原始跳轉，直接死封)
    Location.prototype.assign = function (url) {
      blockNavigation("LOCATION_ASSIGN", url);
    };

    Location.prototype.replace = function (url) {
      blockNavigation("LOCATION_REPLACE", url);
    };

    // (B) Hook Location.prototype 屬性 setters (href, search, pathname, hash)
    ["href", "search", "pathname", "hash"].forEach(function (prop) {
      try {
        const desc = Object.getOwnPropertyDescriptor(Location.prototype, prop);
        if (desc && desc.set) {
          Object.defineProperty(Location.prototype, prop, {
            get: function () {
              return desc.get.call(this);
            },
            set: function (val) {
              blockNavigation("LOCATION_" + prop.toUpperCase(), val);
            },
            configurable: true,
            enumerable: true
          });
        }
      } catch (e) {}
    });

    // (C) Hook Window.prototype.location 屬性 setter (封鎖 window.location = "url")
    const windowProto = Object.getPrototypeOf(window) || window;
    try {
      const locDesc = Object.getOwnPropertyDescriptor(windowProto, "location") || Object.getOwnPropertyDescriptor(window, "location");
      if (locDesc && locDesc.set) {
        Object.defineProperty(windowProto, "location", {
          get: function () {
            return locDesc.get ? locDesc.get.call(this) : window.location;
          },
          set: function (val) {
            blockNavigation("WINDOW_LOCATION_SET", val);
          },
          configurable: true
        });
      }
    } catch (e) {}

    // (D) Hook Document.prototype & HTMLDocument.prototype location (封鎖 document.location = "url")
    [Document.prototype, HTMLDocument.prototype].forEach((docProto) => {
      try {
        const docLocDesc = Object.getOwnPropertyDescriptor(docProto, "location");
        if (docLocDesc && docLocDesc.set) {
          Object.defineProperty(docProto, "location", {
            get: function () {
              return docLocDesc.get ? docLocDesc.get.call(this) : document.location;
            },
            set: function (val) {
              blockNavigation("DOCUMENT_LOCATION_SET", val);
            },
            configurable: true
          });
        }
      } catch (e) {}
    });
  } catch (e) {
    console.error("Hook Location 全屬性失敗:", e);
  }

  // 4. Hook HTMLFormElement.prototype.submit (防止程式碼直接呼叫 form.submit() 繞過事件)
  try {
    const origSubmit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function () {
      const actionUrl = this.getAttribute("action") || window.location.href;
      blockNavigation("FORM_SUBMIT", actionUrl);
    };
  } catch (e) {
    console.error("Hook form.submit 失敗:", e);
  }

  // 5. Hook HTMLElement.prototype.click (防止程式碼直接呼叫 element.click() 觸發導航)
  try {
    const origClick = HTMLElement.prototype.click;
    HTMLElement.prototype.click = function () {
      if (this && (this.tagName === "A" || (this.closest && this.closest("a")))) {
        const anchor = this.tagName === "A" ? this : this.closest("a");
        const href = anchor.getAttribute("href");
        const targetAttr = anchor.getAttribute("target");
        if (href && !href.startsWith("#") && !href.startsWith("javascript:")) {
          const actionType = targetAttr === "_blank" ? "LINK_BLANK" : "LINK_NAVIGATE";
          blockNavigation(actionType, href);
          return;
        }
      }
      origClick.call(this);
    };
  } catch (e) {
    console.error("Hook HTMLElement.click 失敗:", e);
  }

  // 5.5 全頁透明 Clickjacking 點擊誘捕動態偵測器
  function detectClickjackingOverlay(event) {
    try {
      const el = event.target;
      if (!el || el.tagName === "BODY" || el.tagName === "HTML") return;
      const style = window.getComputedStyle(el);
      const isFixed = style.position === "fixed" || style.position === "absolute";
      const opacity = parseFloat(style.opacity || "1");
      const isTransparent = opacity < 0.15 || style.backgroundColor === "rgba(0, 0, 0, 0)" || style.backgroundColor === "transparent";
      const isFullScreen = el.offsetWidth >= window.innerWidth * 0.85 && el.offsetHeight >= window.innerHeight * 0.85;

      if (isFixed && isTransparent && isFullScreen) {
        console.warn("🛡️ 沙盒防禦：觸發全頁透明 Clickjacking 點擊誘捕遮罩！已紀錄事件並防範連帶彈窗", el);
      }
    } catch (e) {}
  }

  // 安全尋找事件目標相對應之 <a> 標籤 (相容 TextNode, SVG, Shadow DOM 與多層嵌套)
  function getAnchorFromEventTarget(el) {
    if (!el) return null;
    const node = el.nodeType === Node.TEXT_NODE ? el.parentNode : el;
    if (!node) return null;
    if (typeof node.closest === "function") {
      return node.closest("a");
    }
    let curr = node;
    while (curr && curr.tagName !== "A" && curr.tagName !== "a") {
      curr = curr.parentElement || curr.parentNode;
    }
    return (curr && (curr.tagName === "A" || curr.tagName === "a")) ? curr : null;
  }

  // 提前於 pointerdown / mousedown 捕獲階段鎖定 <a> 標籤，防止廣告腳本在按壓瞬時篡改 href
  let lastCapturedAnchorUrl = "";
  function captureAnchorOnPress(event) {
    const anchor = getAnchorFromEventTarget(event.target);
    if (anchor) {
      const rawHref = anchor.getAttribute("href") || anchor.getAttribute("data-href") || anchor.getAttribute("data-url") || anchor.href;
      if (rawHref && !rawHref.startsWith("#") && !rawHref.startsWith("javascript:")) {
        lastCapturedAnchorUrl = rawHref;
      }
    }
  }

  ["pointerdown", "mousedown"].forEach((evtType) => {
    document.addEventListener(evtType, captureAnchorOnPress, true);
  });

  // 6. 攔截使用者手動點擊與腳本點擊事件 (<a href="..."> 連結)
  document.addEventListener("click", function (event) {
    detectClickjackingOverlay(event);

    const target = getAnchorFromEventTarget(event.target);
    if (target) {
      const href = target.getAttribute("href") || target.getAttribute("data-href") || target.getAttribute("data-url") || target.href || lastCapturedAnchorUrl;
      const targetAttr = target.getAttribute("target");

      if (href && !href.startsWith("#") && !href.startsWith("javascript:")) {
        event.preventDefault();
        event.stopPropagation();
        if (event.stopImmediatePropagation) event.stopImmediatePropagation();
        
        let actionType = "LINK_NAVIGATE";
        if (targetAttr === "_blank") actionType = "LINK_BLANK";
        if (targetAttr === "_top" || targetAttr === "_parent") actionType = "LINK_TOP_ESCAPE";

        blockNavigation(actionType, href);
        lastCapturedAnchorUrl = "";
      }
    }
  }, true);

  // 7. 攔截表單提交 (<form action="...">)
  document.addEventListener("submit", function (event) {
    const form = event.target;
    if (form) {
      event.preventDefault();
      event.stopPropagation();

      const actionUrl = form.getAttribute("action") || window.location.href;
      const targetAttr = form.getAttribute("target");
      const actionType = (targetAttr === "_top" || targetAttr === "_parent") ? "FORM_TOP_ESCAPE" : "FORM_SUBMIT";
      notifyParent(actionType, actionUrl);
    }
  }, true);

  // 8. 監聽並自動抹除 HTML <meta http-equiv="refresh"> 標籤
  function interceptMetaRefresh() {
    try {
      const metas = document.querySelectorAll('meta[http-equiv="refresh" i]');
      metas.forEach(function (meta) {
        const content = meta.getAttribute("content") || "";
        const match = content.match(/url=\s*['"]?([^'"]+)['"]?/i);
        if (match && match[1]) {
          notifyParent("META_REFRESH", match[1]);
        }
        meta.remove();
      });
    } catch (e) {}
  }

  interceptMetaRefresh();
  const observer = new MutationObserver(function () {
    interceptMetaRefresh();
  });
  if (document.documentElement) {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // 9. 右鍵物件黑名單與動態隱藏機制 (支援子框架 Iframe 與彈窗 Modal)
  let currentTargetElement = null;
  let customMenuEl = null;

  // 判斷 ID 或 Class 是否包含隨機雜湊 Hash (如 10 位數以上的 hex/數字)
  function isDynamicHash(str) {
    if (!str || typeof str !== "string") return false;
    return /[a-f0-9]{10,}|[0-9]{6,}/i.test(str);
  }

  // 動態建立自訂右鍵選單 UI
  function ensureCustomMenu() {
    if (customMenuEl) {
      if (document.documentElement && customMenuEl.parentElement !== document.documentElement) {
        document.documentElement.appendChild(customMenuEl);
      }
      return customMenuEl;
    }
    customMenuEl = document.createElement("div");
    customMenuEl.id = "__sandbox_custom_context_menu__";
    customMenuEl.style.cssText = `
      position: fixed;
      z-index: 2147483647;
      background: #1e293b;
      color: #f8fafc;
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 8px;
      padding: 6px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.8);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      display: none;
      user-select: none;
      min-width: 180px;
    `;
    (document.documentElement || document.body).appendChild(customMenuEl);
    return customMenuEl;
  }

  function showCustomMenu(x, y, menuItems) {
    const menu = ensureCustomMenu();
    if (document.documentElement && document.documentElement.lastElementChild !== menu) {
      document.documentElement.appendChild(menu);
    }
    menu.innerHTML = "";

    menuItems.forEach((itemData) => {
      const item = document.createElement("div");
      item.textContent = itemData.label;
      item.style.cssText = `
        padding: 8px 12px;
        cursor: pointer;
        border-radius: 4px;
        display: flex;
        align-items: center;
        gap: 6px;
        font-weight: 500;
        transition: background 0.2s;
        margin-bottom: 2px;
      `;
      if (itemData.danger) {
        item.onmouseenter = () => { item.style.background = "#ef4444"; };
        item.onmouseleave = () => { item.style.background = "transparent"; };
      } else {
        item.onmouseenter = () => { item.style.background = "#3b82f6"; };
        item.onmouseleave = () => { item.style.background = "transparent"; };
      }

      item.onclick = function (e) {
        e.stopPropagation();
        e.preventDefault();
        hideCustomMenu();
        if (itemData.action) itemData.action();
      };

      menu.appendChild(item);
    });

    localMenuOpenTime = Date.now();
    menu.style.display = "block";
    const menuWidth = menu.offsetWidth || 180;
    const menuHeight = menu.offsetHeight || 60;
    const posX = Math.min(x, window.innerWidth - menuWidth - 10);
    const posY = Math.min(y, window.innerHeight - menuHeight - 10);

    menu.style.left = Math.max(5, posX) + "px";
    menu.style.top = Math.max(5, posY) + "px";
  }

  let localMenuOpenTime = 0;

  function hideCustomMenu() {
    if (Date.now() - localMenuOpenTime < 300) return;
    if (customMenuEl) {
      customMenuEl.style.display = "none";
    }
  }

  function forceHideCustomMenu() {
    if (customMenuEl) {
      customMenuEl.style.display = "none";
    }
  }

  // 點擊與捲動時隱藏自訂選單
  window.addEventListener("click", (e) => {
    if (e.button === 0) hideCustomMenu();
  }, true);
  window.addEventListener("scroll", hideCustomMenu, true);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") forceHideCustomMenu();
  }, true);

  // 尋找最外層的浮動 Modal/Popup 廣告容器 (直到 body 下第一層容器)
  function findTopmostFloatingContainer(el) {
    if (!el || el.tagName === "BODY" || el.tagName === "HTML") return null;

    let current = el;
    let topmost = null;

    while (current && current.tagName !== "BODY" && current.tagName !== "HTML") {
      try {
        const style = window.getComputedStyle(current);
        const isFixedOrAbsolute = style.position === "fixed" || style.position === "absolute";
        const hasHighZIndex = parseInt(style.zIndex, 10) > 100 || style.zIndex === "2147483647";
        const isContainerAttr = /modal|popup|overlay|captcha|container-|dialog|wrapper/i.test(current.className || "") ||
                                /modal|popup|overlay|captcha|container-|dialog|wrapper/i.test(current.id || "");

        if (isFixedOrAbsolute || hasHighZIndex || isContainerAttr || current.tagName === "IFRAME") {
          topmost = current;
        }
      } catch (e) {}
      current = current.parentElement;
    }
    return topmost;
  }

  // 10. 全方位右鍵觸發與攔截 (包含 pointerdown, mousedown, auxclick 與 contextmenu)
  let lastRightClickTime = 0;

  function handleRightClickEvent(e) {
    // 檢查是否為滑鼠右鍵點擊 (button === 2)
    if (e.type !== "contextmenu" && e.button !== 2) {
      return;
    }

    if (customMenuEl && customMenuEl.contains(e.target)) {
      return;
    }

    // 強制阻止廣告腳本透過 pointerdown/mousedown 攔截與取消 contextmenu
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();

    // 避免 pointerdown, mousedown, contextmenu 連續觸發多次選單
    const now = Date.now();
    if (now - lastRightClickTime < 50 && e.type !== "contextmenu") {
      return false;
    }
    lastRightClickTime = now;

    const clientX = e.clientX;
    const clientY = e.clientY;

    // 嘗試使用 elementFromPoint 防止廣告覆蓋透明遮罩
    let targetEl = e.target;
    if (document.elementFromPoint) {
      const elFromPoint = document.elementFromPoint(clientX, clientY);
      if (elFromPoint && elFromPoint !== targetEl && (!customMenuEl || !customMenuEl.contains(elFromPoint))) {
        targetEl = elFromPoint;
      }
    }

    // 若當前在子框架 (Subframe / Iframe 廣告) 中
    if (window.parent !== realTop && realParent) {
      const innerSelector = generateCssSelector(targetEl);
      try {
        realParent.postMessage({
          type: "SUBFRAME_CONTEXT_MENU_TRIGGERED",
          clientX: clientX,
          clientY: clientY,
          selector: innerSelector
        }, "*");
      } catch (err) {
        // Fallback: 若廣播失敗，在子框架內部彈出選單
        const menuItems = [
          {
            label: "🚫 隱藏此物件 (寫入黑名單)",
            selector: innerSelector,
            danger: true
          }
        ];
        showCustomMenu(clientX, clientY, menuItems);
      }
      return false;
    }

    // 主沙盒視窗內點擊
    currentTargetElement = targetEl;
    const menuItems = [];

    // 1. 優先搜尋最外層的浮動 Modal / Popup / Fixed 廣告容器
    const topmostModal = findTopmostFloatingContainer(targetEl);
    if (topmostModal && topmostModal.tagName !== "BODY" && topmostModal.tagName !== "HTML") {
      const modalSelector = generateCssSelector(topmostModal);
      if (modalSelector) {
        menuItems.push({
          label: "📦 隱藏最外層整個廣告彈窗視窗 (Modal)",
          selector: modalSelector,
          danger: true
        });
      }
    }

    // 2. 如果點擊的物件是 Iframe，或是包含在 Iframe 內部
    const iframeEl = targetEl.tagName === "IFRAME" ? targetEl : targetEl.closest("iframe");
    if (iframeEl && iframeEl !== topmostModal) {
      const iframeSelector = generateCssSelector(iframeEl);
      if (iframeSelector) {
        menuItems.push({
          label: "🖼️ 隱藏此廣告框架 (Iframe)",
          selector: iframeSelector,
          danger: false
        });
      }
    }

    // 3. 隱藏特定點擊物件
    const targetSelector = generateCssSelector(targetEl);
    if (targetSelector && targetSelector !== (topmostModal ? generateCssSelector(topmostModal) : "")) {
      menuItems.push({
        label: "🚫 僅隱藏點擊的特定元件",
        selector: targetSelector,
        danger: false
      });
    }

    // 計算在 Viewport 外層 (viewer.html) 中的絕對座標 (加上頂部 52px Navbar 高度)
    const navbarHeight = 52;
    const absoluteClientX = clientX;
    const absoluteClientY = clientY + navbarHeight;

    // 向 Viewport 最外層 (viewer.js) 發送選單廣播，100% 壓過沙盒內任何廣告與 z-index
    try {
      (realTop || realParent || window).postMessage({
        type: "SHOW_VIEWER_CONTEXT_MENU",
        clientX: absoluteClientX,
        clientY: absoluteClientY,
        hostname: window.location.hostname,
        menuItems: menuItems
      }, "*");
    } catch (e) {
      showCustomMenu(clientX, clientY, menuItems);
    }
    return false;
  }

  // 掛載所有相關右鍵事件到 window Capture 階段
  ["pointerdown", "mousedown", "mouseup", "auxclick", "contextmenu"].forEach((eventType) => {
    window.addEventListener(eventType, handleRightClickEvent, { capture: true, passive: false });
  });

  // 計算 DOM 元素的精準 CSS 選擇器 (支援動態 Hash 萬用字元)
  function generateCssSelector(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return "";

    // 特殊處置：若為 Iframe 或 Fixed 廣告視窗
    if (el.tagName === "IFRAME") {
      if (el.id) {
        if (isDynamicHash(el.id)) {
          const prefix = el.id.replace(/[a-f0-9]{10,}.*/i, "").replace(/[0-9]{6,}.*/i, "");
          if (prefix) return `iframe[id^="${prefix}"]`;
        }
        const escapedId = window.CSS && CSS.escape ? CSS.escape(el.id) : el.id;
        return `iframe#${escapedId}, iframe[id^="container-"]`;
      }
      if (el.className && typeof el.className === "string") {
        const firstClass = el.className.trim().split(/\s+/)[0];
        if (firstClass) {
          if (isDynamicHash(firstClass)) {
            const prefix = firstClass.replace(/[a-f0-9]{10,}.*/i, "").replace(/[0-9]{6,}.*/i, "");
            if (prefix) return `iframe[class^="${prefix}"]`;
          }
          return `iframe.${firstClass}`;
        }
      }
    }

    if (el.id && !isDynamicHash(el.id)) {
      const escapedId = window.CSS && CSS.escape ? CSS.escape(el.id) : el.id;
      return "#" + escapedId;
    }

    const path = [];
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE && current.tagName !== "BODY" && current.tagName !== "HTML") {
      let selector = current.tagName.toLowerCase();
      if (current.id) {
        if (isDynamicHash(current.id)) {
          const prefix = current.id.replace(/[a-f0-9]{10,}.*/i, "").replace(/[0-9]{6,}.*/i, "");
          if (prefix) {
            selector += `[id^="${prefix}"]`;
          } else {
            selector += `[id*="${current.id.substring(0, 6)}"]`;
          }
        } else {
          const escapedId = window.CSS && CSS.escape ? CSS.escape(current.id) : current.id;
          selector += "#" + escapedId;
        }
        path.unshift(selector);
        break;
      } else if (current.className && typeof current.className === "string") {
        const firstClass = current.className.trim().split(/\s+/)[0];
        if (firstClass && isDynamicHash(firstClass)) {
          const prefix = firstClass.replace(/[a-f0-9]{10,}.*/i, "").replace(/[0-9]{6,}.*/i, "");
          if (prefix) {
            selector += `[class^="${prefix}"]`;
            path.unshift(selector);
            break;
          }
        }
      }

      let sibling = current;
      let nth = 1;
      while ((sibling = sibling.previousElementSibling)) {
        if (sibling.tagName === current.tagName) nth++;
      }
      let hasSameTagNameSiblings = false;
      let next = current.nextElementSibling;
      while (next) {
        if (next.tagName === current.tagName) {
          hasSameTagNameSiblings = true;
          break;
        }
        next = next.nextElementSibling;
      }
      if (nth > 1 || hasSameTagNameSiblings) {
        selector += `:nth-of-type(${nth})`;
      }

      path.unshift(selector);
      current = current.parentElement;
    }
    return path.join(" > ");
  }

  // 將目標元素寫入黑名單並通知 Viewport
  function addBlacklistForElement(el, customSelector) {
    const selector = customSelector || generateCssSelector(el);
    if (!selector) return;
    console.log("🚫 物件寫入黑名單:", selector);

    if (el && el.style) {
      el.style.setProperty("display", "none", "important");
    }

    try {
      (realTop || realParent || window).postMessage({
        type: "ADD_ELEMENT_TO_BLACKLIST",
        hostname: window.location.hostname,
        selector: selector
      }, "*");
    } catch (e) {
      console.error("傳送黑名單訊息失敗:", e);
    }
  }

  // 11. 隱藏樣式表動態注入與實體 DOM 抹除機制
  let blacklistStyleEl = null;

  function applyBlacklistSelectors(selectors) {
    if (!blacklistStyleEl) {
      blacklistStyleEl = document.createElement("style");
      blacklistStyleEl.id = "__sandbox_blacklist_styles__";
      (document.head || document.documentElement || document.body).appendChild(blacklistStyleEl);
    }
    if (Array.isArray(selectors) && selectors.length > 0) {
      const validSelectors = selectors.filter(s => s && typeof s === "string" && s.trim());
      if (validSelectors.length > 0) {
        blacklistStyleEl.textContent = `${validSelectors.join(",\n")} { display: none !important; visibility: hidden !important; opacity: 0 !important; pointer-events: none !important; }`;
      } else {
        blacklistStyleEl.textContent = "";
      }

      // 雙重保證：實體走訪 DOM 對當前已存在的匹配元素直接強制隱藏
      validSelectors.forEach((sel) => {
        try {
          const matchingElements = document.querySelectorAll(sel);
          matchingElements.forEach((el) => {
            if (el && el.style) {
              el.style.setProperty("display", "none", "important");
              el.style.setProperty("visibility", "hidden", "important");
              el.style.setProperty("opacity", "0", "important");
              el.style.setProperty("pointer-events", "none", "important");
            }
          });
        } catch (e) {}
      });
    } else {
      blacklistStyleEl.textContent = "";
    }
  }

  // 請求初始黑名單列表
  try {
    (realTop || realParent || window).postMessage({
      type: "REQUEST_ELEMENT_BLACKLIST",
      hostname: window.location.hostname
    }, "*");
  } catch (e) {}

  // 監聽來自子框架與 Viewport (viewer.js) 的訊息
  window.addEventListener("message", function (event) {
    const data = event.data;
    if (!data) return;

    if (data.type === "SUBFRAME_CONTEXT_MENU_TRIGGERED") {
      // 尋找是哪一個 <iframe> 觸發的右鍵選單
      const iframes = document.querySelectorAll("iframe");
      let sourceIframe = null;
      for (let i = 0; i < iframes.length; i++) {
        try {
          if (iframes[i].contentWindow === event.source) {
            sourceIframe = iframes[i];
            break;
          }
        } catch (e) {}
      }

      // 備用防護：若跨網域隔離導致 event.source 比對失敗，尋找 fixed / high z-index 或 container- 開頭的廣告 Iframe
      if (!sourceIframe && iframes.length > 0) {
        for (let i = 0; i < iframes.length; i++) {
          try {
            const style = window.getComputedStyle(iframes[i]);
            if (style.position === "fixed" || parseInt(style.zIndex, 10) > 1000 || iframes[i].id.startsWith("container-") || iframes[i].className.includes("container-")) {
              sourceIframe = iframes[i];
              break;
            }
          } catch (e) {}
        }
        if (!sourceIframe && iframes.length === 1) {
          sourceIframe = iframes[0];
        }
      }

      let posX = data.clientX;
      let posY = data.clientY;
      if (sourceIframe) {
        try {
          const rect = sourceIframe.getBoundingClientRect();
          posX = rect.left + data.clientX;
          posY = rect.top + data.clientY;
        } catch (e) {}
      }

      const menuItems = [];

      // 1. 優先搜尋最外層的 Floating Modal / Popup 容器
      const parentModal = sourceIframe ? (findTopmostFloatingContainer(sourceIframe) || sourceIframe.closest('[class*="modal" i], [class*="popup" i], [class*="overlay" i], [class*="captcha" i], [class*="container-" i], [id*="modal" i], [id*="popup" i], [id*="overlay" i], [id*="captcha" i], [id*="container-" i]')) : document.querySelector('iframe[style*="fixed"], iframe[id^="container-"], iframe[class^="container-"]');

      if (parentModal && parentModal.tagName !== "BODY" && parentModal.tagName !== "HTML") {
        const modalSel = generateCssSelector(parentModal);
        if (modalSel) {
          menuItems.push({
            label: "📦 隱藏最外層整個廣告彈窗視窗 (Modal)",
            selector: modalSel,
            danger: true
          });
        }
      }

      // 2. 隱藏子框架 Iframe 本體
      if (sourceIframe && sourceIframe !== parentModal) {
        const iframeSel = generateCssSelector(sourceIframe);
        if (iframeSel) {
          menuItems.push({
            label: "🖼️ 隱藏此廣告框架 (Iframe)",
            selector: iframeSel,
            danger: false
          });
        }
      }

      // 3. 隱藏框架內特定元件
      if (data.selector) {
        menuItems.push({
          label: "🚫 隱藏框架內此特定元件",
          selector: data.selector,
          danger: false
        });
      }

      const navbarHeight = 52;
      const absoluteX = posX;
      const absoluteY = posY + navbarHeight;

      try {
        (realTop || realParent || window).postMessage({
          type: "SHOW_VIEWER_CONTEXT_MENU",
          clientX: absoluteX,
          clientY: absoluteY,
          hostname: window.location.hostname,
          menuItems: menuItems
        }, "*");
      } catch (e) {
        showCustomMenu(posX, posY, menuItems);
      }
    } else if (data.type === "HIDE_INNER_ELEMENT_BY_SELECTOR") {
      if (data.selector) {
        try {
          const el = document.querySelector(data.selector);
          if (el) {
            addBlacklistForElement(el, data.selector);
          }
        } catch (e) {}
      }
    } else if (data.type === "APPLY_ELEMENT_BLACKLIST") {
      if (Array.isArray(data.selectors)) {
        applyBlacklistSelectors(data.selectors);
        // 遞迴廣播給所有子框架 (subframes) 一同套用黑名單抹除
        const childIframes = document.querySelectorAll("iframe");
        childIframes.forEach((frame) => {
          try {
            if (frame.contentWindow) {
              frame.contentWindow.postMessage({
                type: "APPLY_ELEMENT_BLACKLIST",
                hostname: data.hostname,
                selectors: data.selectors
              }, "*");
            }
          } catch (e) {}
        });
      }
    }
  });

})();


