const command = (action, service) => ({
  method: 'shell.run',
  params: { conda: { skip: true }, bluefairy: 'off', message: `node lib/windows-wsl.mjs ${action}${service ? ` ${service}` : ''}` }
});

const explanation = [
  '<p><strong>Just so you know</strong><br>Batshit uses WSL 2 to run on Windows. Pinokio takes care of starting Batshit for you.</p>',
  '<p><strong>Your data</strong><br>Pinokio’s Install, Update and Reset buttons keep your chats, settings and other Batshit data. Your data is stored separately from the app download.</p>',
  '<p><strong>Voice apps</strong><br>If you later use Batshit to run voice software, it stops when you stop Batshit in Pinokio. Voice software you run in other apps stays under those apps’ control.</p>',
  '<p><strong>Other AI tools</strong><br>Apps and tools you already have on Windows are not connected automatically. You can connect compatible ones later in Batshit.</p>'
].join('');

module.exports.windowsMenuState = async () => (await import('./windows-wsl.mjs')).windowsMenuState();

module.exports.windowsActionSteps = async (action, { prerequisites } = {}) => {
  if (action === 'install') {
    const { windowsPrerequisites } = await import('./windows-wsl.mjs');
    const state = prerequisites ? prerequisites() : windowsPrerequisites();
    const releaseGate = command('check-install-release');
    if (state.unsupported) return [releaseGate, { method: 'notify', params: { html: 'This Windows installation does not provide WSL setup. Update Windows to a supported Windows 10/11 version, then return to Install. No Linux environment or data was created.' } }];
    if (!state.ready && state.setupCompleted) return [releaseGate,
      { method: 'notify', params: { html: 'Windows prerequisite commands already completed. Restart Windows if requested, then resume Install; Batshit verifies this user’s readiness without repeating administrator setup. The actual owned Linux start still has to succeed.' } },
      command('resume-wsl-setup'), command('install'), { method: 'notify', params: { html: 'Batshit is installed. Click Start.' } }
    ];
    if (!state.ready) return [
      releaseGate,
      { method: 'input', params: { title: 'Set up WSL 2 for Batshit', description: `${explanation} Windows setup needs administrator approval and may require a restart. This enables WSL without installing a general Ubuntu distribution. Type ENABLE to start Windows setup.`, form: [{ key: 'confirm', title: 'Enable WSL 2' }] } },
      { method: 'shell.run', params: { conda: { skip: true }, bluefairy: 'off', env: { BATSHIT_WSL_SETUP_CONFIRM: '{{input.confirm}}' }, message: 'node lib/windows-wsl.mjs enable-wsl' } },
      { method: 'notify', params: { html: 'If Windows requested a restart, restart it now. Then reopen Pinokio and click Install. Batshit prepares its own environment automatically and preserves an existing default distribution. With no prior default, Windows may select this first imported environment.' } }
    ];
    return [releaseGate, { method: 'notify', params: { html: explanation } }, command('install'), { method: 'notify', params: { html: 'Batshit is installed. Click Start, then create your admin account.' } }];
  }
  if (action === 'start') return [
    command('preflight'),
    { ...command('run', 'redis'), params: { ...command('run', 'redis').params, on: [{ event: '/Batshit: the database is ready\\./', done: true }] } },
    { ...command('run', 'server'), params: { ...command('run', 'server').params, on: [{ event: '/HTTP server running at/', done: true }] } },
    { ...command('run', 'app'), params: { ...command('run', 'app').params, on: [{ event: '/(http:\\/\\/[0-9.:]+)/', done: true }] } },
    { method: 'local.set', params: { url: '{{input.event[1]}}' } },
    { method: 'process.wait', params: { url: '{{local.url}}/api/health', message: 'Waiting for Batshit to answer...', title: 'Starting Batshit', description: 'Pinokio continues when Batshit answers' } }
  ];
  if (action === 'delete-data') return [
    { method: 'input', params: { title: 'Delete all Batshit data?', description: 'This permanently deletes chats, agents, uploads and saved API keys from Batshit’s owned Linux environment. Make a backup in Batshit first. It does not unregister or remove the Linux data disk. Type DELETE to confirm.', form: [{ key: 'confirm', title: 'Type DELETE to confirm' }] } },
    { ...command('delete-data'), params: { ...command('delete-data').params, env: { BATSHIT_DELETE_CONFIRM: '{{input.confirm}}' } } }
  ];
  if (action === 'update' || action === 'reset') return [command(action)];
  throw new Error('Unknown Windows Pinokio action.');
};
