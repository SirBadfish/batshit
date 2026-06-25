const BuiltInService = require('./builtInService');

// Create singleton instances
const builtInService = new BuiltInService();

module.exports = {
  builtInService,
  BuiltInService
};
