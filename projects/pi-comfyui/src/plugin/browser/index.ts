import type {
    PluginActivationContext,
    PluginActivationResult,
    WorkspaceInvalidation,
    WorkspacePanelContext,
} from '@jmfederico/pi-web/plugin-api';
import { attachPanel } from './panel.js';

/* ------------------------------------------------------------------ */
/*  pi-comfyui browser plugin (docs/30 §2)                             */
/* ------------------------------------------------------------------ */

const PLUGIN_ID = 'comfyui';
const PANEL_ID = 'comfyui' as const;

export const comfyuiBrowserPlugin = {
    apiVersion: 4 as const,
    name: 'ComfyUI',

    activate(context: PluginActivationContext): PluginActivationResult {
        return {
            contributions: {
                workspacePanels: [
                    {
                        id: PANEL_ID,
                        title: 'ComfyUI',
                        icon: context.svg`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M5 17l4-4 3 3 3.5-4 3.5 5"/><path d="M9 21h6"/></svg>`,
                        order: 80,
                        invalidationResources: ['workspace.files'],
                        onInvalidate: (_panelContext: WorkspacePanelContext, invalidation?: WorkspaceInvalidation) => {
                            const panel = attachPanel.current();
                            if (!panel) return;
                            // Generated files landing on disk → gallery refresh only; manual → full refresh.
                            if (invalidation?.reason === 'mutation') void panel.refreshGalleryOnly();
                            else void panel.refresh();
                        },
                        render: (panelContext: WorkspacePanelContext) =>
                            context.html`<pi-comfyui-panel .panelCtx=${panelContext}></pi-comfyui-panel>`,
                    },
                ],
            },
            start() {
                /* No capabilities required: the panel talks to this plugin's server peer. */
            },
            dispose() {
                attachPanel.set(null);
            },
        };
    },
};

export default comfyuiBrowserPlugin;
