(function registerBase(global) {
  const namespace = (global.XhsAdapters = global.XhsAdapters || {});

  namespace.BaseExtractorAdapter = class BaseExtractorAdapter {
    constructor(name, version) {
      this.name = name;
      this.version = version;
    }

    canHandle() {
      return false;
    }

    text(selector) {
      const element = document.querySelector(selector);
      return element?.textContent?.trim() || "";
    }

    pageStatus() {
      const visibleText = document.body?.innerText || "";
      if (/登录后查看|请先登录|登录已过期/.test(visibleText)) return "LOGIN_EXPIRED";
      if (/内容不存在|笔记不存在|已删除/.test(visibleText)) return "NOT_FOUND";
      if (/暂无权限|无权查看|仅作者可见/.test(visibleText)) return "NO_PERMISSION";
      return "NORMAL";
    }

    toTopic(element) {
      const style = getComputedStyle(element);
      const tag = element.tagName.toLowerCase();
      const href = element.getAttribute("href");
      const role = element.getAttribute("role");
      const isLinkElement =
        tag === "a" ||
        tag === "button" ||
        role === "link" ||
        element.hasAttribute("onclick") ||
        element.tabIndex >= 0;
      const hasHref = Boolean(href && !href.startsWith("javascript:"));
      const styleFeature =
        element.matches(".topic, [class*='topic'], [class*='hashtag']") ||
        style.cursor === "pointer";
      return {
        displayText: (element.textContent || "").trim(),
        isLinkElement,
        hasHref,
        href: href ? new URL(href, location.href).href : null,
        textColor: style.color,
        styleFeature,
        domPath: this.domPath(element),
      };
    }

    domPath(element) {
      if (element.id) return `#${CSS.escape(element.id)}`;
      const tag = element.tagName.toLowerCase();
      const classes = [...element.classList].slice(0, 2).map((item) => `.${CSS.escape(item)}`).join("");
      return `${tag}${classes}`;
    }

    result(partial) {
      return {
        url: location.href,
        noteId: null,
        title: null,
        body: null,
        topics: [],
        pageStatus: this.pageStatus(),
        isPublic: null,
        authorName: null,
        publishedAt: null,
        extractedAt: new Date().toISOString(),
        adapterName: this.name,
        adapterVersion: this.version,
        ...partial,
      };
    }
  };
})(globalThis);
