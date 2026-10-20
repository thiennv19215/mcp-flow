(function (root) {
  "use strict";

  class ProviderRegistry {
    static parseFlowPath(pathname) {
      const segments = String(pathname || "").split("/").filter(Boolean);
      const projectAt = segments.indexOf("project");
      const prefix = projectAt >= 0 ? segments.slice(0, projectAt) : segments;
      let accountSeen = false;
      let localeSeen = false;
      for (let i = 0; i < prefix.length; i++) {
        if (prefix[i] === "u" && !accountSeen && /^\d+$/.test(prefix[i + 1] || "")) {
          accountSeen = true;
          i++;
          continue;
        }
        if (!localeSeen && /^[a-z]{2,3}(?:-[a-z]{2,4})?$/i.test(prefix[i])) {
          localeSeen = true;
          continue;
        }
        return null;
      }
      const routePrefix = prefix.length ? `/${prefix.join("/")}` : "";
      if (projectAt < 0) return { projectId: null, routePrefix, isProjectEditor: false };
      const projectId = segments[projectAt + 1];
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId || "")) return null;
      const isProjectEditor = segments.length === projectAt + 2;
      return {
        projectId,
        routePrefix,
        isProjectEditor,
        projectPath: `/${segments.slice(0, projectAt + 2).join("/")}`,
      };
    }

    // Alias for backward compatibility
    static parseV2Path(pathname) {
      return this.parseFlowPath(pathname);
    }

    static register(key, factory) {
      if (!Object.prototype.hasOwnProperty.call(this.ORIGINS, key)) throw new TypeError(`Unknown provider driver key: ${key}`);
      if (typeof factory !== "function") throw new TypeError("Provider driver factory is required.");
      this.factories.set(key, factory);
    }

    static describeUrl(value) {
      try {
        const url = new URL(value);
        if (url.origin === this.ORIGINS.flow) {
          const route = this.parseFlowPath(url.pathname);
          return route ? { driverKey: "flow", origin: url.origin, ...route } : null;
        }
        if (url.origin === this.ORIGINS.gemini) {
          return { driverKey: "gemini", origin: url.origin, isProjectEditor: true, routePrefix: "" };
        }
        if (url.origin === this.ORIGINS.chatgpt) {
          return { driverKey: "chatgpt", origin: url.origin, isProjectEditor: true, routePrefix: "" };
        }
        return null;
      } catch { return null; }
    }

    static resolveForUrl(value, options = {}) {
      const context = this.describeUrl(value);
      if (!context) return null;
      // Look up driver by driverKey ("flow", or fallback "flow_v2")
      const factory = this.factories.get(context.driverKey) || (context.driverKey === "flow" ? this.factories.get("flow_v2") : null);
      return { ...context, driver: factory ? factory({ ...options, ...context }) : null };
    }
  }

  ProviderRegistry.ORIGINS = Object.freeze({
    flow: "https://flow.google.com",
    flow_v2: "https://flow.google.com", // Backward compatibility
    gemini: "https://gemini.google.com",
    chatgpt: "https://chatgpt.com",
  });
  ProviderRegistry.factories = new Map();

  root.ProviderRegistry = ProviderRegistry;
  root.FlowDriverRegistry = ProviderRegistry; // Backward compatibility alias
})(globalThis);
