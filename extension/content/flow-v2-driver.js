(function (root) {
  "use strict";

  class FlowV2Driver extends root.FlowPageDriver {
    constructor(context = {}) {
      super({
        ...context,
        context,
        key: "flow_v2",
        origin: root.FlowDriverRegistry.ORIGINS.flow_v2,
        operations: root.FlowPageDriver.OPERATIONS,
      });
    }

    invoke(operation, payload = {}, command = {}) {
      if (operation === "flow.context") {
        const mismatch = this.targetMismatch(command?._flowTarget || command?.flowTarget);
        if (mismatch) return Promise.reject(this.error(mismatch.error, mismatch.message, false, false, mismatch.details));
        return Promise.resolve({ success: true, ...this.context });
      }
      return super.invoke(operation, payload, command);
    }
  }

  root.FlowDriverRegistry.register("flow_v2", context => new FlowV2Driver(context));
  root.FlowV2Driver = FlowV2Driver;
})(globalThis);
