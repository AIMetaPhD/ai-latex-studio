// Settings override used only by the G1 probe (mounted over the CE web service).
// It appends the probe module to CE's module import sequence.
module.exports = {
  moduleImportSequence: [
    'history-v1',
    'launchpad',
    'server-ce-scripts',
    'user-activate',
    'ai-gateway-probe',
  ],
}
