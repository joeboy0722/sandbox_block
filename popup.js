// popup.js - 沙盒獨立控制台腳本

document.addEventListener("DOMContentLoaded", () => {
  const masterToggle = document.getElementById("masterToggle");
  const blockCountEl = document.getElementById("blockCount");
  const quickUrl = document.getElementById("quickUrl");
  const btnQuickLaunch = document.getElementById("btnQuickLaunch");
  const domainList = document.getElementById("domainList");

  // Tab 元素與視窗
  const btnTabSettings = document.getElementById("btnTabSettings");
  const btnTabBlacklist = document.getElementById("btnTabBlacklist");
  const viewSettings = document.getElementById("viewSettings");
  const viewBlacklist = document.getElementById("viewBlacklist");
  const currentDomainDisplay = document.getElementById("currentDomainDisplay");
  const blacklistContainer = document.getElementById("blacklistContainer");

  let currentDomain = "";

  // 1. 頁籤切換事件
  btnTabSettings.addEventListener("click", () => {
    btnTabSettings.classList.add("active");
    btnTabBlacklist.classList.remove("active");
    viewSettings.classList.add("active");
    viewBlacklist.classList.remove("active");
  });

  btnTabBlacklist.addEventListener("click", () => {
    btnTabBlacklist.classList.add("active");
    btnTabSettings.classList.remove("active");
    viewBlacklist.classList.add("active");
    viewSettings.classList.remove("active");
    loadBlacklistForCurrentSite();
  });

  // 2. 載入狀態設定
  chrome.storage.local.get(["enabled", "blockCount", "domainRules"], (res) => {
    masterToggle.checked = res.enabled !== false;
    blockCountEl.textContent = res.blockCount || 0;
    renderDomainRules(res.domainRules || {});
  });

  // 3. 切換全自動攔截總開關
  masterToggle.addEventListener("change", (e) => {
    chrome.storage.local.set({ enabled: e.target.checked });
  });

  // 4. 手動輸入網址快速進入沙盒
  btnQuickLaunch.addEventListener("click", () => {
    let url = quickUrl.value.trim();
    if (!url) return;
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "https://" + url;
    }
    const viewerUrl = chrome.runtime.getURL(`viewer.html?url=${encodeURIComponent(url)}&mode=sandbox`);
    chrome.tabs.create({ url: viewerUrl });
  });

  // 5. 解析當前分頁或 Viewport 沙盒目標網頁的主機名稱 Hostname
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs.length > 0 && tabs[0].url) {
      const pageUrl = tabs[0].url;
      currentDomain = extractDomainFromUrl(pageUrl);
    } else {
      currentDomain = "未知網域";
    }
    currentDomainDisplay.textContent = currentDomain;
  });

  function extractDomainFromUrl(urlStr) {
    try {
      const parsedUrl = new URL(urlStr);
      // 若當前頁面為擴充套件沙盒 Viewport (viewer.html?url=...)
      if (parsedUrl.protocol === "chrome-extension:" && parsedUrl.pathname.endsWith("viewer.html")) {
        const innerUrl = parsedUrl.searchParams.get("url");
        if (innerUrl) {
          return new URL(innerUrl).hostname;
        }
      }
      return parsedUrl.hostname || "未知網域";
    } catch (e) {
      return "未知網域";
    }
  }

  // 6. 載入並渲染當前網頁的黑名單元素
  function loadBlacklistForCurrentSite() {
    if (!currentDomain || currentDomain === "未知網域") {
      blacklistContainer.innerHTML = `<div class="blacklist-item" style="color: #64748b; justify-content: center;">無法識別目前網站網域</div>`;
      return;
    }

    chrome.storage.local.get(["elementBlacklist"], (res) => {
      const allBlacklists = res.elementBlacklist || {};
      const siteSelectors = allBlacklists[currentDomain] || [];
      renderBlacklistItems(siteSelectors);
    });
  }

  function renderBlacklistItems(selectors) {
    blacklistContainer.innerHTML = "";

    if (!selectors || selectors.length === 0) {
      blacklistContainer.innerHTML = `<div class="blacklist-item" style="color: #64748b; justify-content: center;">此網站尚未添加任何黑名單物件</div>`;
      return;
    }

    selectors.forEach((selector, index) => {
      const item = document.createElement("div");
      item.className = "blacklist-item";
      item.innerHTML = `
        <code class="selector-code" title="${selector}">${selector}</code>
        <button class="btn-del btn-remove-blacklist" data-index="${index}">✕ 移除</button>
      `;
      blacklistContainer.appendChild(item);
    });

    // 刪除黑名單選擇器按鈕監聽
    blacklistContainer.querySelectorAll(".btn-remove-blacklist").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const indexToRemove = parseInt(e.target.getAttribute("data-index"), 10);
        chrome.storage.local.get(["elementBlacklist"], (res) => {
          const allBlacklists = res.elementBlacklist || {};
          const siteSelectors = allBlacklists[currentDomain] || [];
          siteSelectors.splice(indexToRemove, 1);
          allBlacklists[currentDomain] = siteSelectors;

          chrome.storage.local.set({ elementBlacklist: allBlacklists }, () => {
            renderBlacklistItems(siteSelectors);
          });
        });
      });
    });
  }

  // 7. 渲染網域偏好記錄列表
  function renderDomainRules(rules) {
    domainList.innerHTML = "";
    const keys = Object.keys(rules);

    if (keys.length === 0) {
      domainList.innerHTML = `<div class="domain-item" style="color: #64748b; justify-content: center;">尚無記錄的網域偏好</div>`;
      return;
    }

    keys.forEach((domain) => {
      const choice = rules[domain];
      const item = document.createElement("div");
      item.className = "domain-item";

      const badgeClass = choice === "sandbox" ? "badge-sandbox" : "badge-direct";
      const badgeText = choice === "sandbox" ? "總是沙盒" : "總是普通";

      item.innerHTML = `
        <span>${domain}</span>
        <div>
          <span class="badge-choice ${badgeClass}">${badgeText}</span>
          <button class="btn-del" data-domain="${domain}">✕</button>
        </div>
      `;

      domainList.appendChild(item);
    });

    // 刪除規則按鈕監聽
    domainList.querySelectorAll(".btn-del").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const domainToDelete = e.target.getAttribute("data-domain");
        chrome.storage.local.get(["domainRules"], (res) => {
          const currentRules = res.domainRules || {};
          delete currentRules[domainToDelete];
          chrome.storage.local.set({ domainRules: currentRules }, () => {
            renderDomainRules(currentRules);
          });
        });
      });
    });
  }
});
