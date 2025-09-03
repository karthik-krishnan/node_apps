// validators/flows/<flowId>/index.js
module.exports = {
    // Optional: pick schema(s) to validate against
    selectSchema(payload /*, ctx */) {
      if (payload?.type === "login")   return "login.schema.json";              // in this flow folder
      if (payload?.type === "payment") return "@common/payment.schema.json";    // shared schema
      return null; // let the engine use heuristics (type.json, single-file, or try-all)
    },
  
    // Optional: custom checks (return [] if all good)
    validate(payload, ctx) {
    const errs = [];
    // Example cross-event rule: payment must come after an order in the same flow
    if (payload?.data.event_name === "Accounts > Login") {
        const haveOrder = ctx.findEvents({
            flowId: ctx.flowId,
            where: (e) => e.payload?.beaconId == 321
        }).length > 0;
        if (!haveOrder) errs.push("Valid Login Required");

        const haveOrder1 = ctx.findEvents({
            flowId: ctx.flowId,
            where: (e) => e.payload?.beaconId == 123
        }).length > 0;
        if (!haveOrder1) errs.push("Invalid Login Required");        
    }
      return errs;
    }
  };
  