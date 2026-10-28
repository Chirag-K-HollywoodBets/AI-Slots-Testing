function withUsage(response, usage) {
  return usage ? { ...response, usage } : response;
}

function pendingPlan(plan, usage, expires) {
  return { plan, usage, expires };
}

module.exports = { withUsage, pendingPlan };
