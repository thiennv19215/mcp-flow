(function (root) {
  class FlowLibraryOperations {
    constructor(driver) {
      this.driver = driver;
    }
    supports(operation) {
      return [
        "flow.projects.list",
        "flow.asset.download",
        "flow.state",
        "flow.assets.list",
        "flow.characters.list",
        "flow.asset.rename",
        "flow.asset.trash",
      ].includes(operation);
    }
    error(...args) {
      return this.driver.error(...args);
    }
    async execute(name, payload = {}, command = {}) {
      const tiles = root.FlowTiles;
      const menu = root.FlowMediaMenu;
      if (name === "flow.projects.list") {
        if (/\/project\/[0-9a-f-]{36}(?:\/|$)/i.test(location.pathname)) {
          throw this.error("FLOW_HOMEPAGE_REQUIRED", "Project discovery needs the Flow home page. The connector should open a temporary home tab.", true);
        }
        return menu.scanNativeProjects();
      }

      if (name === "flow.asset.download") {
        const prefix = String(payload.name || "").toLowerCase();
        if (!prefix && !payload.id) throw this.error("FLOW_INVALID_ARGUMENT", "Asset name or media id is required.");
        if (payload.id) return menu.triggerFlowDownload(String(payload.name || ""), payload.quality, String(payload.id));
        const assets = await menu.scanNativeAssets();
        const candidates = assets.filter(a => a.name.toLowerCase().startsWith(prefix));
        const matches = [];
        for (const a of candidates) {
          const count = await tiles.countFlowTitleAcrossGrid(a.name);
          for (let i = 0; i < count; i++) matches.push(a);
          if (matches.length > 1) break;
        }
        if (!matches.length) throw this.error("FLOW_ASSET_NOT_FOUND", `No asset title begins with "${payload.name}".`, true);
        if (matches.length > 1) throw this.error("FLOW_AMBIGUOUS_ASSET", `${matches.length} assets begin with "${payload.name}"; no download was started.`, true);
        return menu.triggerFlowDownload(matches[0].name, payload.quality);
      }

      if (name === "flow.state") {
        const state = menu.nativeRead("flowState");
        const settingsButton = root.flowButton?.("Settings trigger");
        if (settingsButton) state.composer = (settingsButton.innerText || root.accessibleName?.(settingsButton)).replace(/\s+/g, " ").trim();
        if (payload.detailed && state.signedIn) {
          const account = root.flowButton?.("Account details");
          if (account) {
            account.click(); await root.wait?.(500);
            const creditLink = [...document.querySelectorAll("a")].find(a => /(?:Google Flow credits|credits?|tín dụng)/i.test(root.accessibleName?.(a) || a.innerText || "") && root.visible?.(a));
            const creditText = creditLink ? (root.accessibleName?.(creditLink) || creditLink.innerText || "") : "";
            const n = Number(creditText.replace(/[^\d]/g, ""));
            state.credits_remaining = Number.isFinite(n) && creditText ? n : undefined;
            state.plan = [...document.querySelectorAll("button")].find(b => /(?:Account details|Chi tiết tài khoản|Tài khoản)/i.test(root.accessibleName?.(b) || b.innerText || ""))?.innerText?.split("\n")[0];
            const close = root.flowButton?.("Close account panel"); if (close) close.click();
          }
        }
        return state;
      }

      if (name === "flow.assets.list") return menu.scanNativeAssets();
      if (name === "flow.characters.list") return menu.scanNativeCharacters();

      if (name === "flow.asset.rename" || name === "flow.asset.trash") {
        const title = String(payload.name || "");
        if (!title) throw this.error("FLOW_INVALID_ARGUMENT", "Asset name is required.");
        const copies = await tiles.countFlowTitleAcrossGrid(title);
        if (copies !== 1) throw this.error(copies > 1 ? "FLOW_AMBIGUOUS_ASSET" : "FLOW_ASSET_NOT_FOUND", copies > 1 ? `${copies} assets are named "${title}"; no mutation was performed.` : `Could not find asset "${title}".`, true);
        const tile = await tiles.findFlowTile(title);
        if (!tile) throw this.error("FLOW_ASSET_NOT_FOUND", `Could not find asset "${title}" after scanning the project grid.`, true);
        tile.scrollIntoView({ block: "center" }); await root.wait?.(150);
        const more = root.flowButton?.("More options", tile); if (!more) throw this.error("FLOW_TILE_MENU_MISSING", `Could not open options for "${title}".`, true);
        more.click(); await root.wait?.(200);
        const actionPatterns = name === "flow.asset.trash"
          ? /^(?:Move to trash|Chuyển vào thùng rác|Xóa|Xóa tệp|Xóa nội dung)$/i
          : /^(?:Rename|Đổi tên)$/i;
        const menuEl = [...document.querySelectorAll('[role="menuitem"]')].find(item => {
          if (!root.visible?.(item)) return false;
          const label = (root.accessibleName?.(item) || item.innerText || item.textContent || "").trim();
          return actionPatterns.test(label);
        });
        if (!menuEl) throw this.error("FLOW_MENU_ITEM_MISSING", `Flow did not show "${name === "flow.asset.trash" ? "Move to trash" : "Rename"}" for "${title}".`, true);
        menuEl.click(); await root.wait?.(250);
        if (name === "flow.asset.trash") return { trashed: title };
        const input = [...document.querySelectorAll('input:not([type="file"]),[contenteditable="true"]')].find(el => root.visible?.(el));
        if (!input) throw this.error("FLOW_RENAME_INPUT_MISSING", "Flow opened rename but no editable title field is visible.", false, true);
        const newName = String(payload.newName || "");
        if (!newName) throw this.error("FLOW_INVALID_ARGUMENT", "newName is required.");
        if (input.isContentEditable) input.textContent = newName;
        else { input.value = newName; input.dispatchEvent(new Event("input", { bubbles: true })); }
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
        await root.wait?.(400);
        return { renamed: title, name: newName };
      }

      return undefined;
    }
  }
  root.FlowLibraryOperations = FlowLibraryOperations;
})(globalThis);
