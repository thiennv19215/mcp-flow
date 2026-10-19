(function (root) {
  "use strict";

  class FlowDriverRegistry {
    static parseV2Path(pathname) {
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
      return {
        projectId,
        routePrefix,
        isProjectEditor: true,
        projectPath: `/${segments.slice(0, projectAt + 2).join("/")}`,
      };
    }

    static register(key, factory) {
      if (!Object.prototype.hasOwnProperty.call(this.ORIGINS, key)) throw new TypeError(`Unknown Flow driver key: ${key}`);
      if (typeof factory !== "function") throw new TypeError("Flow driver factory is required.");
      this.factories.set(key, factory);
    }

    static describeUrl(value) {
      try {
        const url = new URL(value);
        if (url.origin !== this.ORIGINS.flow_v2) return null;
        const route = this.parseV2Path(url.pathname);
        return route ? { driverKey: "flow_v2", origin: url.origin, ...route } : null;
      } catch { return null; }
    }

    static resolveForUrl(value, options = {}) {
      const context = this.describeUrl(value);
      if (!context) return null;
      const factory = this.factories.get(context.driverKey);
      return { ...context, driver: factory ? factory({ ...options, ...context }) : null };
    }
  }

  FlowDriverRegistry.ORIGINS = Object.freeze({ flow_v2: "https://flow.google.com" });
  FlowDriverRegistry.factories = new Map();
  root.FlowDriverRegistry = FlowDriverRegistry;
})(globalThis);
