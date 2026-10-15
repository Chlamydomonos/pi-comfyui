import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import type { FileTreeEntry, JsonValue, PluginPeerChannel, WorkspacePanelContext } from '@jmfederico/pi-web/plugin-api';
import type { ComfyJobRecord, ComfySummary, ServerFrame, ExtensionFrame } from '../../shared/protocol.js';

/* ------------------------------------------------------------------ */
/*  Local view state                                                   */
/* ------------------------------------------------------------------ */

interface LiveProgress {
    value: number;
    max: number;
}

interface LivePreview {
    mime: string;
    data: string; // base64
}

interface GeneratorInfo {
    name: string;
    title?: string;
}

const MEDIA_EXTENSIONS = new Set([
    'png',
    'jpg',
    'jpeg',
    'webp',
    'gif',
    'bmp',
    'tiff',
    'mp4',
    'webm',
    'mov',
    'mkv',
    'mp3',
    'wav',
    'flac',
    'ogg',
    'm4a',
]);

const DEFAULT_OUTPUT_DIR = 'comfyui-output';

function extOf(path: string): string {
    const base = path.split('/').pop() ?? path;
    const dot = base.lastIndexOf('.');
    return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function dirOf(path: string): string {
    const idx = path.lastIndexOf('/');
    return idx > 0 ? path.slice(0, idx) : '';
}

function isMedia(entry: FileTreeEntry): boolean {
    return entry.type === 'file' && MEDIA_EXTENSIONS.has(extOf(entry.path));
}

function formatTime(iso: string | undefined): string {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(ms: number | undefined): string {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
    if (ms < 1000) return `${ms}ms`;
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

const STATE_LABEL: Record<string, string> = {
    queued: '排队中',
    running: '生成中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
};

/* ------------------------------------------------------------------ */
/*  Panel element                                                      */
/* ------------------------------------------------------------------ */

export class PiComfyuiPanel extends LitElement {
    /** Host-provided panel context; a fresh object arrives on every render. */
    static properties = {
        panelCtx: { attribute: false, state: true },
        lightbox: { attribute: false, state: true },
    };

    panelCtx?: WorkspacePanelContext;
    lightbox: string | undefined;

    static styles = css`
        :host {
            display: block;
            font-size: 13px;
            color: var(--vscode-foreground, var(--sl-color-neutral-700, #ddd));
            padding: 8px 12px 24px;
        }
        h3 {
            font-size: 13px;
            font-weight: 600;
            margin: 18px 0 8px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        h3:first-child {
            margin-top: 4px;
        }
        .count {
            color: var(--vscode-descriptionForeground, #888);
            font-weight: 400;
            font-size: 12px;
        }
        button {
            font: inherit;
            font-size: 12px;
            padding: 2px 10px;
            border-radius: 6px;
            border: 1px solid var(--vscode-input-border, rgba(128, 128, 128, 0.4));
            background: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.15));
            color: inherit;
            cursor: pointer;
        }
        button:hover {
            filter: brightness(1.15);
        }
        button.danger {
            border-color: rgba(224, 84, 84, 0.55);
            color: #ff9d9d;
        }
        button.armed {
            background: rgba(224, 84, 84, 0.35);
            color: #fff;
        }
        button:disabled {
            opacity: 0.5;
            cursor: default;
        }
        .banner {
            margin: 6px 0;
            padding: 6px 10px;
            border-radius: 6px;
            background: rgba(224, 84, 84, 0.18);
            border: 1px solid rgba(224, 84, 84, 0.4);
            color: #ffb1b1;
            font-size: 12px;
        }
        .muted {
            color: var(--vscode-descriptionForeground, #888);
            font-size: 12px;
        }
        .run-card {
            border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.3));
            border-radius: 8px;
            padding: 10px 12px;
            margin: 6px 0;
        }
        .run-head {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .state-chip {
            font-size: 11px;
            padding: 1px 8px;
            border-radius: 999px;
            background: rgba(128, 128, 128, 0.2);
        }
        .state-chip.completed {
            background: rgba(80, 200, 120, 0.25);
        }
        .state-chip.failed {
            background: rgba(224, 84, 84, 0.3);
        }
        .state-chip.running {
            background: rgba(80, 140, 240, 0.3);
        }
        .progress {
            margin-top: 8px;
            height: 6px;
            border-radius: 3px;
            background: rgba(128, 128, 128, 0.2);
            overflow: hidden;
        }
        .progress > div {
            height: 100%;
            background: var(--vscode-focusBorder, #4a9eff);
            transition: width 0.3s ease;
        }
        .preview {
            margin-top: 10px;
            max-width: 420px;
        }
        .preview img {
            display: block;
            width: 100%;
            height: auto;
            border-radius: 6px;
            border: 1px solid rgba(128, 128, 128, 0.3);
        }
        .gen-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
            gap: 8px;
        }
        .gen-card {
            border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.3));
            border-radius: 8px;
            padding: 8px 10px;
        }
        .gen-card .name {
            font-weight: 600;
        }
        .gen-card .desc {
            color: var(--vscode-descriptionForeground, #999);
            font-size: 12px;
            margin-top: 2px;
        }
        .gallery {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
            gap: 6px;
        }
        .shot {
            position: relative;
            border-radius: 6px;
            overflow: hidden;
            border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.3));
            aspect-ratio: 1;
            background: rgba(128, 128, 128, 0.1);
        }
        .shot img,
        .shot .media-fallback {
            width: 100%;
            height: 100%;
            object-fit: cover;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 11px;
        }
        .shot .del {
            position: absolute;
            top: 3px;
            right: 3px;
            padding: 0 6px;
            border-radius: 4px;
        }
        .shot .name {
            position: absolute;
            left: 0;
            right: 0;
            bottom: 0;
            padding: 2px 6px;
            font-size: 10px;
            background: rgba(0, 0, 0, 0.55);
            color: #fff;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .job-row {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 4px 6px;
            border-radius: 6px;
        }
        .job-row:nth-child(odd) {
            background: rgba(128, 128, 128, 0.07);
        }
        .job-row .grow {
            flex: 1;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .lightbox {
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.82);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 100;
            cursor: zoom-out;
        }
        .lightbox img {
            max-width: 92vw;
            max-height: 92vh;
            border-radius: 8px;
        }
    `;

    /* view state */
    private summary: ComfySummary | undefined;
    private records: ComfyJobRecord[] = [];
    private generators: GeneratorInfo[] = [];
    private banner: string | undefined;
    private galleries = new Map<string, FileTreeEntry[]>();
    private galleryScanned = false;
    private liveProgress = new Map<string, LiveProgress>();
    private livePreview = new Map<string, LivePreview>();
    private livePhase = new Map<string, string>();
    private confirmDelete: string | null = null;
    private clearArmed = false;
    private seq = 0;
    private refreshTimer: ReturnType<typeof setTimeout> | undefined;
    private lastWorkspaceId: string | undefined;
    private lastSessionId: string | undefined;

    /* live channel */
    private channel: PluginPeerChannel | undefined;
    private liveSessionId: string | undefined;
    private channelAbort: AbortController | undefined;

    connectedCallback(): void {
        super.connectedCallback();
        attachPanel.set(this);
        this.scheduleRefresh(0);
    }

    disconnectedCallback(): void {
        attachPanel.set(null);
        this.closeChannel();
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.channelAbort?.abort();
        super.disconnectedCallback();
    }

    protected willUpdate(changed: Map<string, unknown>): void {
        if (changed.has('panelCtx') && this.panelCtx) {
            const workspaceId = this.panelCtx.workspace.id;
            if (this.lastWorkspaceId !== workspaceId) {
                this.lastWorkspaceId = workspaceId;
                this.resetData();
                this.scheduleRefresh(0);
            }
        }
    }

    /* ---------------- data ---------------- */

    private sessionId(): string | undefined {
        const session = this.panelCtx?.state?.selectedSession;
        return session && !session.pending ? session.id : undefined;
    }

    private resetData(): void {
        this.summary = undefined;
        this.records = [];
        this.generators = [];
        this.galleries.clear();
        this.galleryScanned = false;
        this.liveProgress.clear();
        this.livePreview.clear();
        this.livePhase.clear();
        this.banner = undefined;
    }

    private scheduleRefresh(delayMs: number): void {
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => void this.refresh(), delayMs);
    }

    /** Full refresh: summary + history + gallery. */
    async refresh(): Promise<void> {
        const seq = ++this.seq;
        const ctx = this.panelCtx;
        if (!ctx?.peer) return;

        // (Re)open the live frame channel when a real session is selected.
        this.ensureLiveChannel(this.sessionId());

        try {
            const request = this.peerRequest();
            if (!request) {
                this.banner = '面板未连接到宿主 peer';
                return;
            }
            const result = (await request('summary', {})) as unknown;
            if (seq === this.seq) this.summary = result as ComfySummary;
        } catch (error) {
            if (seq === this.seq) this.banner = errorText(error);
        }
        try {
            const request = this.peerRequest();
            const result = request ? ((await request('list', { limit: 50 })) as unknown) : undefined;
            if (seq === this.seq && result !== undefined) this.records = result as ComfyJobRecord[];
        } catch (error) {
            if (seq === this.seq) this.banner = errorText(error);
        }
        if (seq === this.seq) await this.refreshGallery(seq);
        if (seq === this.seq) this.requestUpdate();
    }

    /** Lightweight refresh used on workspace.files mutation. */
    async refreshGalleryOnly(): Promise<void> {
        const seq = ++this.seq;
        await this.refreshGallery(seq);
        if (seq === this.seq) this.requestUpdate();
    }

    private async refreshGallery(seq: number): Promise<void> {
        const ctx = this.panelCtx;
        if (!ctx) return;
        const dirs = new Set<string>([DEFAULT_OUTPUT_DIR]);
        for (const record of this.records) {
            for (const file of record.files ?? []) {
                const dir = dirOf(file.path);
                if (dir) dirs.add(dir);
            }
        }
        for (const dir of dirs) {
            try {
                const tree = await ctx.files.listFiles(dir);
                if (seq !== this.seq) return;
                this.galleries.set(dir, tree.entries.filter(isMedia));
            } catch {
                this.galleries.delete(dir); // directory may not exist yet
            }
        }
        // Drop galleries for directories no longer referenced.
        for (const dir of [...this.galleries.keys()]) {
            if (!dirs.has(dir)) this.galleries.delete(dir);
        }
        this.galleryScanned = true;
        if (seq === this.seq) this.requestUpdate();
    }

    /* ---------------- live channel ---------------- */

    private ensureLiveChannel(sessionId: string | undefined): void {
        if (sessionId && sessionId === this.liveSessionId && this.channel) return;
        if (this.sessionIdChanged(sessionId)) this.closeChannel();
        if (!sessionId) return;
        const peer = this.panelCtx?.peer;
        if (!peer?.openChannel) return;
        this.liveSessionId = sessionId;
        this.channelAbort = new AbortController();
        void this.openChannelSafely(sessionId, this.channelAbort.signal);
    }

    private sessionIdChanged(sessionId: string | undefined): boolean {
        return sessionId !== this.liveSessionId;
    }

    private async openChannelSafely(sessionId: string, signal: AbortSignal): Promise<void> {
        try {
            const peer = this.panelCtx?.peer;
            if (!peer?.openChannel) return;
            const channel = await peer.openChannel(
                'live',
                { sessionId },
                {
                    signal,
                    onData: (data: JsonValue) => this.onFrame(data),
                },
            );
            if (this.liveSessionId !== sessionId) {
                channel.close('superseded');
                return;
            }
            this.channel = channel;
        } catch (error) {
            this.banner = `实时帧通道打开失败:${errorText(error)}`;
            this.requestUpdate();
        }
    }

    private closeChannel(): void {
        this.channel?.close('panel disconnected');
        this.channel = undefined;
        this.liveSessionId = undefined;
    }

    private onFrame(data: JsonValue): void {
        if (!data || typeof data !== 'object') return;
        const frame = data as unknown as ServerFrame;
        if (frame.kind === 'history') {
            this.records = frame.records;
            this.scheduleRefresh(400); // gallery may reference new directories
            return;
        }
        if (frame.kind === 'error') {
            this.banner = frame.message;
            this.requestUpdate();
            return;
        }
        const ext = frame as ExtensionFrame;
        switch (ext.kind) {
            case 'job': {
                const existing = this.records.find((r) => r.jobId === ext.jobId);
                const record: ComfyJobRecord = existing ?? {
                    jobId: ext.jobId,
                    generator: ext.generator,
                    state: ext.state,
                    files: [],
                };
                record.generator = ext.generator;
                record.state = ext.state;
                if (ext.title) record.title = ext.title;
                if (ext.startedAt) record.startedAt = ext.startedAt;
                if (ext.endedAt) record.endedAt = ext.endedAt;
                if (ext.error) record.error = ext.error;
                if (ext.promptId) record.promptId = ext.promptId;
                if (!existing) this.records = [record, ...this.records];
                if (ext.state === 'completed' || ext.state === 'failed' || ext.state === 'cancelled') {
                    this.liveProgress.delete(ext.jobId);
                    this.livePreview.delete(ext.jobId);
                    this.livePhase.delete(ext.jobId);
                } else if (ext.phase) {
                    this.livePhase.set(ext.jobId, ext.phase);
                }
                break;
            }
            case 'progress':
                this.liveProgress.set(ext.jobId, { value: ext.value, max: ext.max });
                break;
            case 'preview':
                this.livePreview.set(ext.jobId, { mime: ext.mime, data: ext.data });
                break;
            case 'outputs': {
                const record = this.records.find((r) => r.jobId === ext.jobId);
                if (record) record.files = ext.files;
                this.scheduleRefresh(200);
                break;
            }
            case 'generators':
                this.generators = ext.list;
                break;
            default:
                break;
        }
        this.requestUpdate();
    }

    /* ---------------- actions ---------------- */

    /**
     * Narrowed request-capable peer, or undefined when the host provided only
     * a channel-capable peer (or nothing at all).
     */
    private peerRequest(): ((operation: string, input?: unknown) => Promise<unknown>) | undefined {
        const peer = this.panelCtx?.peer as
            | { request?: (operation: string, input?: unknown) => Promise<unknown> }
            | undefined;
        return peer?.request;
    }

    private async cancelJob(jobId: string): Promise<void> {
        const sessionId = this.sessionId();
        const request = this.peerRequest();
        if (!request) return;
        try {
            const result = (await request('cancel', { jobId, ...(sessionId ? { sessionId } : {}) })) as {
                ok?: boolean;
                error?: string;
            };
            if (result && result.ok === false) this.banner = result.error ?? '取消请求被拒绝';
        } catch (error) {
            this.banner = `取消失败:${errorText(error)}`;
        }
        this.requestUpdate();
    }

    private async clearHistory(): Promise<void> {
        const request = this.peerRequest();
        if (!request) return;
        this.clearArmed = false;
        try {
            await request('history-clear', {});
            this.records = [];
            this.galleries.clear();
            this.galleryScanned = false;
            await this.refreshGallery(++this.seq);
        } catch (error) {
            this.banner = `清除历史失败:${errorText(error)}`;
        }
        this.requestUpdate();
    }

    private async deleteFile(path: string): Promise<void> {
        if (this.confirmDelete !== path) {
            this.confirmDelete = path;
            setTimeout(() => {
                if (this.confirmDelete === path) {
                    this.confirmDelete = null;
                    this.requestUpdate();
                }
            }, 4000);
            this.requestUpdate();
            return;
        }
        this.confirmDelete = null;
        const ctx = this.panelCtx;
        if (!ctx) return;
        try {
            await ctx.files.deleteFile(path);
        } catch (error) {
            this.banner = `删除失败:${errorText(error)}`;
        }
        await this.refreshGalleryOnly();
    }

    /* ---------------- url helpers ---------------- */

    private previewUrl(path: string, modifiedAt?: string): string | undefined {
        const files = this.panelCtx?.files;
        if (files && 'capabilityVersion' in files && files.capabilityVersion === 1) {
            return files.previewUrl(path, modifiedAt ? { version: modifiedAt } : undefined);
        }
        return undefined; // legacy hosts: no browser-ready URLs
    }

    private downloadUrl(path: string): string | undefined {
        const files = this.panelCtx?.files;
        if (files && 'capabilityVersion' in files && files.capabilityVersion === 1) {
            return files.downloadUrl(path);
        }
        return undefined;
    }

    /* ---------------- render ---------------- */

    protected render(): TemplateResult {
        const activeJob = this.summary?.active;
        const galleryEntries = [...this.galleries.entries()].filter(([, entries]) => entries.length > 0);

        return html`
            ${this.banner ? html`<div class="banner">${this.banner}</div>` : nothing} ${this.renderRunCard(activeJob)}
            ${this.renderGenerators()} ${this.renderGallery(galleryEntries)} ${this.renderHistory()}
            ${this.lightbox
                ? html`<div
                      class="lightbox"
                      @click=${() => {
                          this.lightbox = undefined;
                          this.requestUpdate();
                      }}
                  >
                      <img src=${this.lightbox} alt="" />
                  </div>`
                : nothing}
        `;
    }

    private renderRunCard(activeJob: ComfySummary['active']): TemplateResult {
        if (!activeJob) {
            return html`<h3>
                    ComfyUI
                    <span class="count"
                        >${this.summary?.generatorCount !== undefined
                            ? `· ${this.summary.generatorCount} 个生成器`
                            : ''}</span
                    >
                </h3>
                <div class="muted">空闲 — 没有进行中的任务。通过对话中的 comfyui_generate 工具发起生成。</div>`;
        }
        const progress = this.liveProgress.get(activeJob.jobId);
        const preview = this.livePreview.get(activeJob.jobId);
        const phase = this.livePhase.get(activeJob.jobId) ?? activeJob.phase;
        const percent = progress && progress.max > 0 ? Math.round((progress.value / progress.max) * 100) : undefined;
        const sessionId = this.sessionId();
        return html`<h3>ComfyUI <span class="count">· 当前任务</span></h3>
            <div class="run-card">
                <div class="run-head">
                    <span class="state-chip ${activeJob.state}"
                        >${STATE_LABEL[activeJob.state] ?? activeJob.state}</span
                    >
                    <strong>${activeJob.generator}</strong>
                    <span class="muted">${activeJob.state === 'queued' ? '等待执行' : (phase ?? '')}</span>
                    <button
                        class="danger"
                        ?disabled=${!sessionId}
                        title=${sessionId ? '中断该任务' : '未选中会话,无法发送取消命令'}
                        @click=${() => void this.cancelJob(activeJob.jobId)}
                    >
                        取消
                    </button>
                </div>
                ${progress
                    ? html`<div class="progress"><div style=${`width:${percent ?? 0}%`}></div></div>
                          <div class="muted">
                              ${progress.value} / ${progress.max}${percent !== undefined ? ` · ${percent}%` : ''}
                          </div>`
                    : html`<div class="progress"><div style="width:8%"></div></div>
                          <div class="muted">等待 ComfyUI 进度…</div>`}
                ${preview
                    ? html`<div class="preview">
                          <img src="data:${preview.mime};base64,${preview.data}" alt="preview" />
                      </div>`
                    : nothing}
            </div>`;
    }

    private renderGenerators(): TemplateResult {
        return html`<h3>
                生成器 <span class="count">${this.generators.length > 0 ? `· ${this.generators.length} 个` : ''}</span>
            </h3>
            ${this.generators.length === 0
                ? html`<div class="muted">
                      暂无。把生成器放到工作区 generators/*.js(参考 examples/generators/),生成器会在此列出。
                  </div>`
                : html`<div class="gen-grid">
                      ${this.generators.map(
                          (g) =>
                              html` <div class="gen-card">
                                  <div class="name">${g.name}</div>
                                  ${g.title && g.title !== g.name ? html`<div class="desc">${g.title}</div>` : nothing}
                              </div>`,
                      )}
                  </div>`}`;
    }

    private renderGallery(groups: [string, FileTreeEntry[]][]): TemplateResult {
        return html`<h3>
                画廊
                <span class="count"
                    >${groups.length > 0 ? `· ${groups.reduce((acc, [, e]) => acc + e.length, 0)} 个文件` : ''}</span
                >
            </h3>
            ${!this.galleryScanned
                ? html`<div class="muted">扫描输出目录中…</div>`
                : groups.length === 0
                  ? html`<div class="muted">暂无输出。完成一次生成后,文件会显示在这里。</div>`
                  : groups.map(
                        ([dir, entries]) =>
                            html` <div class="muted" style="margin:6px 0 4px;">${dir}</div>
                                <div class="gallery">
                                    ${entries.map((entry) => {
                                        const url = this.previewUrl(entry.path, entry.modifiedAt);
                                        const isImage = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tiff'].includes(
                                            extOf(entry.path),
                                        );
                                        const delLabel = this.confirmDelete === entry.path ? '确认?' : '×';
                                        return html` <div class="shot" title=${entry.path}>
                                            ${url && isImage
                                                ? html`<img
                                                      src=${url}
                                                      alt=${entry.name}
                                                      @click=${() => {
                                                          this.lightbox = url;
                                                          this.requestUpdate();
                                                      }}
                                                  />`
                                                : html`<a
                                                      class="media-fallback"
                                                      href=${this.downloadUrl(entry.path) ?? '#'}
                                                      target="_blank"
                                                      rel="noopener"
                                                      >${entry.name}</a
                                                  >`}
                                            <button
                                                class="del ${this.confirmDelete === entry.path ? 'armed' : 'danger'}"
                                                @click=${() => void this.deleteFile(entry.path)}
                                            >
                                                ${delLabel}
                                            </button>
                                            <div class="name">${entry.name}</div>
                                        </div>`;
                                    })}
                                </div>`,
                    )} `;
    }

    private renderHistory(): TemplateResult {
        return html`<h3>
                历史 <span class="count">${this.records.length > 0 ? `· ${this.records.length} 条` : ''}</span>
                ${this.records.length > 0
                    ? html`<button
                          class=${this.clearArmed ? 'armed danger' : 'danger'}
                          @click=${() => {
                              if (!this.clearArmed) {
                                  this.clearArmed = true;
                                  setTimeout(() => {
                                      this.clearArmed = false;
                                      this.requestUpdate();
                                  }, 4000);
                              } else {
                                  void this.clearHistory();
                              }
                              this.requestUpdate();
                          }}
                      >
                          ${this.clearArmed ? '确认清除?' : '清除历史'}
                      </button>`
                    : nothing}
            </h3>
            ${this.records.length === 0
                ? html`<div class="muted">暂无历史记录。</div>`
                : html`<div>
                      ${this.records.map(
                          (r) =>
                              html` <div class="job-row">
                                  <span class="state-chip ${r.state}">${STATE_LABEL[r.state] ?? r.state}</span>
                                  <span class="grow">
                                      <strong>${r.generator}</strong>
                                      ${r.title && r.title !== r.generator ? html` · ${r.title}` : nothing}
                                      ${r.files.length > 0 ? html` · ${r.files.length} 个产物` : nothing}
                                      ${r.error ? html` · <span style="color:#ff9d9d;">${r.error}</span>` : nothing}
                                  </span>
                                  <span class="muted"
                                      >${formatTime(r.startedAt)}${formatDuration(r.durationMs)
                                          ? ` · ${formatDuration(r.durationMs)}`
                                          : ''}</span
                                  >
                              </div>`,
                      )}
                  </div>`}`;
    }
}

/* ---------------- singleton registry (panel ↔ plugin entry bridge) ---------- */

const registry = { current: null as PiComfyuiPanel | null };
export const attachPanel = {
    current(): PiComfyuiPanel | null {
        return registry.current;
    },
    set(panel: PiComfyuiPanel | null): void {
        registry.current = panel;
    },
};

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

if (!customElements.get('pi-comfyui-panel')) {
    customElements.define('pi-comfyui-panel', PiComfyuiPanel);
}
