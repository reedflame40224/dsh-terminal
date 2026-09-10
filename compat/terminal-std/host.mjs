import { mountTerminal } from './terminal.mjs';

export const surface = Object.freeze({ apiVersion: 'local.dsh-terminal/v1alpha1', kind: 'TerminalPanel' });
export default {
  activate(context) {
    const ui = context.protocols.client({ apiVersion: 'ui.dsh/v1alpha1', kind: 'ContributionHost' });
    if (!ui) throw new Error('TerminalPanel surface was not negotiated');
    ui.register({ descriptor: { id: 'terminal', surface, content: { title: 'Terminal', abi: 1 } },
      localModule: { mount: mountTerminal } });
  },
};
