module.exports = {
  // Dense pixel validation keeps the same Math object without repeated VM-global lookups.
  sandboxInjectedGlobals: ['Math']
};
