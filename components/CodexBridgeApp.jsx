'use client';

import { useEffect, useRef, useState } from 'react';
import {
  BRIDGE_STORAGE_KEYS,
  DEFAULT_BRIDGE_TOKEN,
  buildBridgeUrl,
  createDefaultCapabilities,
  getInitialBridgeToken,
} from '../lib/bridge-config';
import { buildTunnelCommands, createDefaultSettings } from '../lib/tunnel-config';

const DEFAULT_WORKSPACE = '/Volumes/new/dev/web/codeonline';
const TRUSTED_PROJECTS = [
  '/Volumes/new/dev/web/codeonline',
  '/Volumes/new/dev/xcode/qickcoder/QuickRecorder',
  '/Volumes/new/dev/xcode/hiker',
  '/Users/loong/Documents/test01',
  '/Volumes/new/dev/ragTest',
];
const PROMPT_SUGGESTIONS = [
  'Review this repo and list the highest-risk issues first.',
  'Refactor the current feature without changing behavior, then explain the diff.',
  'Improve this UI with stronger hierarchy and better mobile spacing.',
];
const RECENT_WORKSPACES_KEY = BRIDGE_STORAGE_KEYS.recentWorkspaces;
const BRIDGE_SETTINGS_KEY = BRIDGE_STORAGE_KEYS.settings;
const BRIDGE_SESSION_CACHE_KEY = 'codex-bridge-session-cache-v1';
const BRIDGE_UI_STATE_KEY = 'codex-bridge-ui-state-v1';
const MAX_CACHED_MESSAGES = 80;
const MAX_CACHED_THREADS = 50;

function makeId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

function createSession(workspace, id = 'default-session') {
  return {
    id,
    label: shortWorkspaceLabel(workspace) || 'New thread',
    workspace,
    threadId: null,
    currentTurnId: null,
    isTurnActive: false,
    turnState: 'idle',
    messages: [],
    threadList: [],
    model: '',
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    typing: false,
    loadedThreadBlocked: false,
    threadStatus: { label: 'Idle', tone: 'idle' },
  };
}

function isThreadBlocked(thread) {
  const threadStatus = thread?.status?.type || thread?.status;
  if (threadStatus && !['idle', 'done', 'completed'].includes(threadStatus)) {
    return true;
  }
  const turns = thread?.turns || [];
  const lastTurn = turns[turns.length - 1];
  const turnStatus = lastTurn?.status?.type || lastTurn?.status;
  return Boolean(turnStatus && !['done', 'completed'].includes(turnStatus));
}

function getThreadStatusInfo(thread) {
  const threadStatus = thread?.status?.type || thread?.status || 'idle';
  const activeFlags = thread?.status?.activeFlags || [];
  const turns = thread?.turns || [];
  const lastTurn = turns[turns.length - 1];
  const turnStatus = lastTurn?.status?.type || lastTurn?.status || null;

  if (activeFlags.includes('waitingOnApproval')) {
    return { label: 'Waiting approval', tone: 'running' };
  }
  if (threadStatus === 'active') {
    return { label: turnStatus === 'inProgress' ? 'Running' : 'Active', tone: 'running' };
  }
  if (threadStatus === 'completed' || threadStatus === 'done') {
    return { label: 'Completed', tone: 'done' };
  }
  if (threadStatus === 'error' || turnStatus === 'error') {
    return { label: 'Error', tone: 'error' };
  }
  return { label: 'Idle', tone: 'idle' };
}

function normalizeTimestamp(value) {
  if (!value) return Date.now();
  return value < 1e12 ? value * 1000 : value;
}

function formatTime(value) {
  return new Date(normalizeTimestamp(value)).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(normalizeTimestamp(value));
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString();
}

function normalizeFileEntries(entries) {
  return (entries || []).map((entry) => ({
    name: entry.name || entry.fileName || '',
    type: entry.type || (entry.isDirectory ? 'directory' : 'file'),
  }));
}

function shortWorkspaceLabel(path) {
  if (!path) return 'No workspace';
  const parts = path.split('/').filter(Boolean);
  return parts.slice(-2).join('/') || path;
}

function buildWorkspaceList(current, stored = []) {
  const seen = new Set();
  return [current, ...stored, ...TRUSTED_PROJECTS]
    .filter(Boolean)
    .filter((item) => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    })
    .slice(0, 8);
}

function sanitizeMessagesForCache(messages) {
  return (messages || []).slice(-MAX_CACHED_MESSAGES).map((message) => ({
    id: message.id,
    kind: message.kind,
    role: message.role,
    header: message.header,
    content: message.content,
    createdAt: message.createdAt,
    status: message.status,
    command: message.command,
    changes: message.changes,
    tone: message.tone,
    label: message.label,
    open: message.open,
    summary: message.summary,
  }));
}

function sanitizeThreadsForCache(threadList) {
  return (threadList || []).slice(0, MAX_CACHED_THREADS).map((thread) => ({
    id: thread.id,
    name: thread.name || null,
    preview: thread.preview || '',
    updatedAt: thread.updatedAt || null,
    createdAt: thread.createdAt || null,
    status: thread.status || { type: 'idle' },
    path: thread.path || null,
    cwd: thread.cwd || null,
  }));
}

function sanitizeSessionForCache(session) {
  if (!session) return null;
  return {
    id: session.id,
    label: session.label,
    workspace: session.workspace,
    threadId: session.threadId,
    currentTurnId: session.currentTurnId,
    isTurnActive: session.isTurnActive,
    turnState: session.turnState,
    messages: sanitizeMessagesForCache(session.messages),
    threadList: sanitizeThreadsForCache(session.threadList),
    model: session.model,
    approvalPolicy: session.approvalPolicy,
    sandbox: session.sandbox,
    typing: session.typing,
    loadedThreadBlocked: session.loadedThreadBlocked,
    threadStatus: session.threadStatus,
  };
}

function restoreCachedSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    ...createSession(raw.workspace || DEFAULT_WORKSPACE, raw.id || 'default-session'),
    label: raw.label || shortWorkspaceLabel(raw.workspace || DEFAULT_WORKSPACE) || 'New thread',
    threadId: raw.threadId || null,
    currentTurnId: raw.currentTurnId || null,
    isTurnActive: Boolean(raw.isTurnActive),
    turnState: raw.turnState || 'idle',
    messages: Array.isArray(raw.messages) ? raw.messages : [],
    threadList: Array.isArray(raw.threadList) ? raw.threadList : [],
    model: raw.model || '',
    approvalPolicy: raw.approvalPolicy || 'on-request',
    sandbox: raw.sandbox || 'workspace-write',
    typing: Boolean(raw.typing),
    loadedThreadBlocked: Boolean(raw.loadedThreadBlocked),
    threadStatus: raw.threadStatus || { label: 'Idle', tone: 'idle' },
  };
}

function sanitizeUiState(state) {
  return {
    pendingWorkspace: state.pendingWorkspace || DEFAULT_WORKSPACE,
    sidebarOpen: Boolean(state.sidebarOpen),
    debugOpen: Boolean(state.debugOpen),
    workspaceCollapsed: Boolean(state.workspaceCollapsed),
    sidebarWorkspaceCollapsed: Boolean(state.sidebarWorkspaceCollapsed),
    threadFilter: state.threadFilter || '',
  };
}

function getSuggestedDeviceName() {
  if (typeof window === 'undefined') return 'My browser';
  const parts = [];
  const platform = window.navigator.platform || '';
  const userAgent = window.navigator.userAgent || '';
  if (/iphone/i.test(userAgent)) parts.push('iPhone');
  else if (/ipad/i.test(userAgent)) parts.push('iPad');
  else if (/android/i.test(userAgent)) parts.push('Android');
  else if (/mac/i.test(platform)) parts.push('Mac');
  else if (/win/i.test(platform)) parts.push('Windows');
  return [...new Set(parts)].join(' · ') || 'My browser';
}

function withTokenQuery(url, token) {
  if (!token) return url;
  const nextUrl = new URL(url, typeof window !== 'undefined' ? window.location.origin : 'http://localhost');
  nextUrl.searchParams.set('token', token);
  return nextUrl.toString();
}

function normalizeAdminToken(token) {
  const trimmed = String(token || '').trim();
  return trimmed && trimmed !== 'changeme' ? trimmed : '';
}

function shouldUseAdminTokenForRuntime(authState) {
  return authState?.status !== 'authorized' || authState?.mode !== 'device';
}

function escapeHtml(text) {
  return String(text || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function decorateRenderedMarkdown(html) {
  if (typeof window === 'undefined') return html;

  const template = document.createElement('template');
  template.innerHTML = html;

  template.content.querySelectorAll('pre').forEach((pre) => {
    const code = pre.querySelector('code');
    const languageMatch = code?.className?.match(/language-([\w-]+)/);
    const language = languageMatch?.[1] || 'text';
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block';

    const header = document.createElement('div');
    header.className = 'code-header';

    const lang = document.createElement('span');
    lang.className = 'code-lang';
    lang.textContent = language;
    header.appendChild(lang);

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'code-copy';
    copyBtn.textContent = 'Copy';
    copyBtn.dataset.copy = code?.textContent || pre.textContent || '';
    header.appendChild(copyBtn);

    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(header);
    wrapper.appendChild(pre);
  });

  template.content.querySelectorAll('table').forEach((table) => {
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    table.parentNode.insertBefore(wrap, table);
    wrap.appendChild(table);
  });

  template.content.querySelectorAll('a').forEach((link) => {
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
  });

  return template.innerHTML;
}

function renderMarkdown(text) {
  const safeMarkdown = escapeHtml(text);
  if (typeof window !== 'undefined' && window.marked) {
    try {
      return decorateRenderedMarkdown(window.marked.parse(safeMarkdown));
    } catch {
      return safeMarkdown;
    }
  }
  return safeMarkdown;
}

function flattenTurnItems(turns) {
  const messages = [];
  for (const turn of turns || []) {
    for (const item of turn.items || []) {
      if (item.type === 'userMessage') {
        const text = (item.content || []).map((part) => part.text || '').filter(Boolean).join('\n');
        if (text) {
          messages.push({
            id: makeId('msg'),
            kind: 'chat',
            role: 'user',
            header: 'You',
            content: text,
            createdAt: Date.now(),
          });
        }
      }
      if (item.type === 'agentMessage' && item.text) {
        messages.push({
          id: makeId('msg'),
          kind: 'chat',
          role: 'agent',
          header: 'Codex',
          content: item.text,
          createdAt: Date.now(),
        });
      }
      if (item.type === 'commandExecution') {
        messages.push({
          id: makeId('command'),
          kind: 'command',
          status: item.status || 'running',
          command: item.command || 'command',
        });
      }
      if (item.type === 'fileChange') {
        messages.push({
          id: makeId('filechange'),
          kind: 'file-change',
          changes: item.changes || [],
        });
      }
      if (item.type === 'contextCompaction') {
        messages.push({
          id: makeId('system'),
          kind: 'system',
          tone: 'neutral',
          content: '📦 Context compacted',
        });
      }
    }
  }
  return messages;
}

function MessageItem({ message, onToggleReasoning }) {
  if (message.kind === 'system') {
    return <div className={`system-line${message.tone === 'error' ? ' error' : message.tone === 'success' ? ' success' : ''}`}>{message.content}</div>;
  }

  if (message.kind === 'command') {
    return (
      <div className="event-line">
        <div className="event-label">Command · {message.status || 'running'}</div>
        <pre className="event-body">{message.command}</pre>
      </div>
    );
  }

  if (message.kind === 'file-change') {
    return (
      <div className="event-line">
        <div className="event-label">Files · {message.changes?.length || 0}</div>
        <div className="event-list">
          {(message.changes || []).map((change, index) => {
            const label = change.type === 'add' ? '+' : change.type === 'delete' ? '-' : '~';
            return (
              <div className="event-list-row" key={`${change.path || 'change'}-${index}`}>
                <span className="event-change">{label}</span>
                <span className="event-path">{change.path}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (message.kind === 'approval') {
    return (
      <div className="event-line">
        <div className="event-label">Approval</div>
        <div className="event-body">{message.summary || 'Waiting for approval decision.'}</div>
      </div>
    );
  }

  if (message.kind === 'reasoning') {
    return (
      <div className="reasoning-row">
        <button className="reasoning-toggle" onClick={() => onToggleReasoning(message.id)} type="button">
          <span className={`arrow${message.open ? ' open' : ''}`}>▶</span>
          <span>{message.label || 'Thought process'}</span>
        </button>
        <div className={`reasoning-content${message.open ? ' visible' : ''}`}>{message.content}</div>
      </div>
    );
  }

  if (message.kind === 'typing') {
    return (
      <div className="message-row agent">
        <div className="message-inner">
          <div className="message-header">
            <div className="msg-avatar agent">C</div>
            <div className="msg-role">Codex</div>
          </div>
          <div className="typing-dots">
            <span />
            <span />
            <span />
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className={`message-row ${message.role === 'user' ? 'user' : 'assistant'}`}>
      <div className="message-inner">
        <div className="msg-header">
          <div className={`msg-avatar ${message.role}`}>{message.role === 'user' ? 'U' : 'C'}</div>
          <div className="msg-role">{message.header}</div>
          <div className="msg-time">{formatTime(message.createdAt)}</div>
        </div>
        {message.role === 'agent' ? (
          <div className="msg-content" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }} />
        ) : (
          <div className="msg-content text-content">{message.content}</div>
        )}
      </div>
    </div>
  );
}

export default function CodexBridgeApp() {
  const initialSession = useRef(createSession(DEFAULT_WORKSPACE)).current;
  const [hydrated, setHydrated] = useState(false);
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const [debugEvents, setDebugEvents] = useState([]);
  const [sessions, setSessions] = useState([initialSession]);
  const [activeSessionId, setActiveSessionId] = useState(initialSession.id);
  const [connectionStatus, setConnectionStatus] = useState('disconnected');
  const [composerText, setComposerText] = useState('');
  const [modelOptions, setModelOptions] = useState([]);
  const [token, setToken] = useState(DEFAULT_BRIDGE_TOKEN);
  const [authState, setAuthState] = useState({ status: 'checking', mode: null, device: null, isAdmin: false });
  const [deviceNameInput, setDeviceNameInput] = useState('My browser');
  const [adminTokenInput, setAdminTokenInput] = useState('');
  const [deviceBusy, setDeviceBusy] = useState(false);
  const [deviceList, setDeviceList] = useState([]);
  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false);
  const [workspaceBrowserPath, setWorkspaceBrowserPath] = useState('/');
  const [workspaceBrowserEntries, setWorkspaceBrowserEntries] = useState([]);
  const [pendingWorkspace, setPendingWorkspace] = useState(DEFAULT_WORKSPACE);
  const [approvalQueue, setApprovalQueue] = useState([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [debugOpen, setDebugOpen] = useState(false);
  const [workspaceCollapsed, setWorkspaceCollapsed] = useState(false);
  const [sidebarWorkspaceCollapsed, setSidebarWorkspaceCollapsed] = useState(false);
  const [threadFilter, setThreadFilter] = useState('');
  const [recentWorkspaces, setRecentWorkspaces] = useState([DEFAULT_WORKSPACE, ...TRUSTED_PROJECTS.slice(0, 3)]);
  const [settings, setSettings] = useState(createDefaultSettings());
  const [capabilities, setCapabilities] = useState(createDefaultCapabilities());
  const [markdownTick, setMarkdownTick] = useState(0);
  const eventSourceRef = useRef(null);
  const clientIdRef = useRef(null);
  const nextIdRef = useRef(1);
  const pendingRequestsRef = useRef(new Map());
  const reconnectTimerRef = useRef(null);
  const connectDelayRef = useRef(null);
  const transportGenerationRef = useRef(0);
  const viewportModeRef = useRef(null);
  const activeSessionIdRef = useRef(activeSessionId);
  const sessionsRef = useRef(sessions);
  const streamRef = useRef({ agentMessageId: null, reasoningMessageId: null, sessionId: activeSessionId });
  const messagesEndRef = useRef(null);
  const composerRef = useRef(null);

  const activeSession = sessions.find((session) => session.id === activeSessionId) || sessions[0];
  const approvalRequest = approvalQueue[0] || null;

  function pushDebug(label, detail = '') {
    const line = `${new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })} ${label}${detail ? ` :: ${detail}` : ''}`;
    setDebugEvents((prev) => [line, ...prev].slice(0, 24));
  }

  function notifyBrowser(title, body) {
    if (!settings.browserNotifications || typeof window === 'undefined' || !('Notification' in window)) {
      return;
    }
    if (Notification.permission !== 'granted') {
      return;
    }
    try {
      const notification = new Notification(title, {
        body,
        tag: 'codex-bridge',
      });
      window.setTimeout(() => notification.close(), 5000);
    } catch {}
  }

  function rejectPendingRequests(message) {
    for (const [id, request] of pendingRequestsRef.current.entries()) {
      request.reject(new Error(message));
      pendingRequestsRef.current.delete(id);
    }
  }

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    setHydrated(true);
    pushDebug('hydrate', 'client mounted');
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(BRIDGE_SESSION_CACHE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const restored = restoreCachedSession(parsed.session);
      if (!restored) return;
      setSessions([restored]);
      setActiveSessionId(restored.id);
      setPendingWorkspace(restored.workspace || DEFAULT_WORKSPACE);
      pushDebug('cache restore', `thread=${restored.threadId || 'none'}`);
    } catch {}
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 720px)');
    const syncViewport = (event) => setIsMobileViewport(event.matches);

    setIsMobileViewport(mediaQuery.matches);
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', syncViewport);
      return () => mediaQuery.removeEventListener('change', syncViewport);
    }

    mediaQuery.addListener(syncViewport);
    return () => mediaQuery.removeListener(syncViewport);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const nextToken = getInitialBridgeToken();
    const cwd = params.get('cwd') || DEFAULT_WORKSPACE;
    pushDebug('boot params', `token=${nextToken ? 'present' : 'missing'} cwd=${cwd}`);
    setToken(nextToken);
    setAdminTokenInput(normalizeAdminToken(nextToken));
    setDeviceNameInput(getSuggestedDeviceName());
    setPendingWorkspace(cwd);
    setSessions((prev) => prev.map((session) => (session.id === activeSessionIdRef.current ? { ...session, workspace: cwd } : session)));
    if (params.has('token')) {
      params.delete('token');
      const nextQuery = params.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}`);
    }
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(RECENT_WORKSPACES_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      setRecentWorkspaces(buildWorkspaceList(DEFAULT_WORKSPACE, parsed));
    } catch {
      setRecentWorkspaces(buildWorkspaceList(DEFAULT_WORKSPACE, []));
    }
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(BRIDGE_SETTINGS_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      setSettings({ ...createDefaultSettings(), ...parsed });
    } catch {
      setSettings(createDefaultSettings());
    }
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(BRIDGE_UI_STATE_KEY);
      const parsed = raw ? sanitizeUiState(JSON.parse(raw)) : null;
      if (!parsed) return;
      setPendingWorkspace(parsed.pendingWorkspace);
      setSidebarOpen(parsed.sidebarOpen);
      setDebugOpen(parsed.debugOpen);
      setWorkspaceCollapsed(parsed.workspaceCollapsed);
      setSidebarWorkspaceCollapsed(parsed.sidebarWorkspaceCollapsed);
      setThreadFilter(parsed.threadFilter);
    } catch {}
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const nextList = buildWorkspaceList(activeSession.workspace, recentWorkspaces);
    setRecentWorkspaces(nextList);
    try {
      window.localStorage.setItem(RECENT_WORKSPACES_KEY, JSON.stringify(nextList));
    } catch {}
  }, [activeSession.workspace, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(BRIDGE_SETTINGS_KEY, JSON.stringify(settings));
    } catch {}
  }, [settings, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(
        BRIDGE_UI_STATE_KEY,
        JSON.stringify(sanitizeUiState({
          pendingWorkspace,
          sidebarOpen,
          debugOpen,
          workspaceCollapsed,
          sidebarWorkspaceCollapsed,
          threadFilter,
        })),
      );
    } catch {}
  }, [pendingWorkspace, sidebarOpen, debugOpen, workspaceCollapsed, sidebarWorkspaceCollapsed, threadFilter, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    const active = sessions.find((session) => session.id === activeSessionId) || sessions[0];
    if (!active) return;
    try {
      window.localStorage.setItem(
        BRIDGE_SESSION_CACHE_KEY,
        JSON.stringify({
          savedAt: Date.now(),
          session: sanitizeSessionForCache(active),
        }),
      );
    } catch {}
  }, [sessions, activeSessionId, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    async function loadCapabilities() {
      try {
        const response = await fetch(buildBridgeUrl('/capabilities'));
        const data = await response.json();
        if (!cancelled) {
          setCapabilities(data);
        }
      } catch {
        if (!cancelled) {
          setCapabilities(createDefaultCapabilities());
        }
      }
    }
    loadCapabilities();
  return () => {
      cancelled = true;
    };
  }, [hydrated]);

  useEffect(() => {
    if (!approvalRequest || !settings.autoApproveAll) return;
    const timer = window.setTimeout(() => {
      respondApproval(true);
      appendSystemMessage(activeSessionIdRef.current, 'Auto-approved by local All Accept setting.', 'success');
      notifyBrowser('Approval auto-accepted', 'A pending approval was accepted automatically.');
    }, 120);
  return () => window.clearTimeout(timer);
  }, [approvalRequest, settings.autoApproveAll]);

  useEffect(() => {
    const handleMarkedReady = () => setMarkdownTick((value) => value + 1);
    window.addEventListener('marked-ready', handleMarkedReady);
  return () => window.removeEventListener('marked-ready', handleMarkedReady);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    if (viewportModeRef.current === isMobileViewport) return;

    viewportModeRef.current = isMobileViewport;
    if (isMobileViewport) {
      setSidebarOpen(false);
      setWorkspaceCollapsed(false);
      setDebugOpen(false);
      return;
    }

    setSidebarOpen(true);
    setWorkspaceCollapsed(false);
  }, [hydrated, isMobileViewport]);

  useEffect(() => {
    const logVisibility = () => pushDebug('document visibility', document.visibilityState);
    const logPageShow = (event) => pushDebug('pageshow', event.persisted ? 'persisted' : 'fresh');
    const logPageHide = (event) => pushDebug('pagehide', event.persisted ? 'persisted' : 'normal');
    const logBeforeUnload = () => pushDebug('beforeunload');

    document.addEventListener('visibilitychange', logVisibility);
    window.addEventListener('pageshow', logPageShow);
    window.addEventListener('pagehide', logPageHide);
    window.addEventListener('beforeunload', logBeforeUnload);
  return () => {
      document.removeEventListener('visibilitychange', logVisibility);
      window.removeEventListener('pageshow', logPageShow);
      window.removeEventListener('pagehide', logPageHide);
      window.removeEventListener('beforeunload', logBeforeUnload);
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' });
  }, [activeSession.messages, markdownTick]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'l' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        updateActiveSession((session) => ({ ...session, messages: [] }));
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (!settingsOpen) return undefined;
    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        setSettingsOpen(false);
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [settingsOpen]);

  async function fetchBridgeJson(path, options = {}, adminToken = token) {
    const target = withTokenQuery(buildBridgeUrl(path), normalizeAdminToken(adminToken));
    const response = await fetch(target, {
      method: options.method || 'GET',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
      body: options.body,
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {}

    if (!response.ok) {
      throw new Error(payload?.error || `Request failed: ${response.status}`);
    }
    return payload;
  }

  async function refreshDeviceStatus(adminToken = token) {
    try {
      const payload = await fetchBridgeJson('/device-status', {}, '');
      setAuthState({
        status: 'authorized',
        mode: payload.mode,
        device: payload.device || null,
        isAdmin: Boolean(payload.isAdmin),
      });
      return payload;
    } catch (error) {
      setAuthState({ status: 'unauthorized', mode: null, device: null, isAdmin: false });
      return null;
    }
  }

  async function refreshDeviceList(adminToken = token) {
    const nextToken = normalizeAdminToken(adminToken);
    if (!nextToken) {
      setDeviceList([]);
      return;
    }
    try {
      const payload = await fetchBridgeJson('/devices', {}, nextToken);
      setDeviceList(payload.devices || []);
    } catch {
      setDeviceList([]);
    }
  }

  useEffect(() => {
    if (!hydrated) return undefined;

    let cancelled = false;
    (async () => {
      const status = await refreshDeviceStatus(token);
      if (cancelled) return;
      if (status?.isAdmin || normalizeAdminToken(token)) {
        await refreshDeviceList(token);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [hydrated, token]);

  useEffect(() => {
    if (!hydrated || authState.status !== 'authorized') return undefined;

    let disposed = false;
    pushDebug('transport effect', `start token=${token ? 'present' : 'missing'}`);

    function cleanupTransport(target = eventSourceRef.current) {
      if (!target) return;
      pushDebug('transport cleanup');
      target.onopen = null;
      target.onerror = null;
      target.onmessage = null;
      target.close();
      if (eventSourceRef.current === target) {
        eventSourceRef.current = null;
      }
      clientIdRef.current = null;
    }

    function connect() {
      if (disposed) return;

      const generation = ++transportGenerationRef.current;
      pushDebug('transport connect', `generation=${generation}`);
      setConnectionStatus('connecting');
      const runtimeToken = shouldUseAdminTokenForRuntime(authState) ? normalizeAdminToken(token) : '';
      const source = new window.EventSource(withTokenQuery(buildBridgeUrl('/codex-events'), runtimeToken));
      eventSourceRef.current = source;

      source.onopen = () => {
        if (disposed || eventSourceRef.current !== source || transportGenerationRef.current !== generation) return;
        pushDebug('transport open', `generation=${generation}`);
      };

      source.onerror = () => {
        if (disposed || eventSourceRef.current !== source || transportGenerationRef.current !== generation) return;
        pushDebug('transport error', `generation=${generation}`);
      };

      source.addEventListener('hello', (event) => {
        if (disposed || eventSourceRef.current !== source || transportGenerationRef.current !== generation) return;
        const payload = JSON.parse(event.data);
        clientIdRef.current = payload.clientId;
        pushDebug('transport hello', payload.clientId);
      });

      source.addEventListener('status', async (event) => {
        if (disposed || eventSourceRef.current !== source || transportGenerationRef.current !== generation) return;
        const payload = JSON.parse(event.data);
        pushDebug('transport status', payload.state);

        if (payload.state === 'connecting') {
          setConnectionStatus('connecting');
          return;
        }

        if (payload.state === 'connected') {
          setConnectionStatus('connected');

          try {
            pushDebug('rpc initialize', 'request');
            await sendRpc('initialize', {
              clientInfo: { name: 'codex_bridge_next', title: 'Codex Bridge Next UI', version: '2.0.0' },
            });
            pushDebug('rpc initialize', 'ok');
            await sendNotification('initialized');
            pushDebug('rpc initialized', 'notification sent');

            try {
              pushDebug('rpc model/list', 'request');
              const models = await sendRpc('model/list', {});
              const list = models.data || [];
              pushDebug('rpc model/list', `ok count=${list.length}`);
              setModelOptions(list);
              updateActiveSession((session) => ({
                ...session,
                model: session.model || list[0]?.name || list[0]?.id || 'gpt-5.4-codex',
              }));
            } catch {
              pushDebug('rpc model/list', 'fallback');
              setModelOptions([{ name: 'gpt-5.4-codex', displayName: 'gpt-5.4-codex' }]);
              updateActiveSession((session) => ({ ...session, model: session.model || 'gpt-5.4-codex' }));
            }

            const currentSession = sessionsRef.current.find((session) => session.id === activeSessionIdRef.current);
            pushDebug('rpc fs/readDirectory', currentSession?.workspace || DEFAULT_WORKSPACE);
            await loadWorkspace(currentSession?.workspace || DEFAULT_WORKSPACE);
            pushDebug('rpc fs/readDirectory', 'ok');
            pushDebug('rpc thread/list', 'request');
            await updateThreadList(currentSession?.workspace || DEFAULT_WORKSPACE);
            pushDebug('rpc thread/list', 'ok');
          } catch (error) {
            pushDebug('rpc init pipeline', `error=${error.message}`);
            appendSystemMessage(activeSessionIdRef.current, `Init error: ${error.message}`, 'error');
          }
          return;
        }

        if (payload.state === 'closed' || payload.state === 'error') {
          pushDebug('transport close', `generation=${generation} reason=${payload.reason || payload.message || 'none'}`);
          setConnectionStatus('disconnected');
          appendSystemMessage(activeSessionIdRef.current, 'Disconnected. Reconnecting...', 'error');
          rejectPendingRequests('Bridge disconnected');
          source.close();
          eventSourceRef.current = null;
          clientIdRef.current = null;
          reconnectTimerRef.current = window.setTimeout(connect, 3000);
        }
      });

      source.addEventListener('message', (event) => {
        if (disposed || eventSourceRef.current !== source || transportGenerationRef.current !== generation) return;
        pushDebug('transport message', 'received');
        let data;
        try {
          data = JSON.parse(JSON.parse(event.data).payload);
        } catch {
          pushDebug('transport message', 'json parse failed');
          return;
        }
        handleMessage(data);
      });

      source.addEventListener('error', () => {
        if (disposed || eventSourceRef.current !== source || transportGenerationRef.current !== generation) return;
        setConnectionStatus('disconnected');
        appendSystemMessage(activeSessionIdRef.current, 'Disconnected. Reconnecting...', 'error');
        rejectPendingRequests('Bridge transport error');
        source.close();
        eventSourceRef.current = null;
        clientIdRef.current = null;
        reconnectTimerRef.current = window.setTimeout(connect, 3000);
      });
    }

    connectDelayRef.current = window.setTimeout(() => {
      pushDebug('transport schedule', 'connect in 300ms');
      connect();
    }, 300);
  return () => {
      disposed = true;
      pushDebug('transport effect', 'cleanup');
      if (connectDelayRef.current) {
        window.clearTimeout(connectDelayRef.current);
      }
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      cleanupTransport(eventSourceRef.current);
    };
  }, [hydrated, token, authState.status, authState.mode]);

  if (!hydrated) {
    return <div className="bridge-root hydration-shell" />;
  }

  function updateActiveSession(updater) {
    updateSession(activeSessionIdRef.current, updater);
  }

  function updateSession(sessionId, updater) {
    setSessions((prev) =>
      prev.map((session) => (session.id === sessionId ? updater(session) : session)),
    );
  }

  async function resetCurrentThread() {
    updateActiveSession((session) => ({
      ...session,
      threadId: null,
      currentTurnId: null,
      isTurnActive: false,
      turnState: 'idle',
      label: shortWorkspaceLabel(session.workspace),
      messages: [{ id: makeId('system'), kind: 'system', tone: 'success', content: 'Starting new thread...' }],
    }));
    await startThread();
    await updateThreadList();
  }

  function appendSystemMessage(sessionId, content, tone = 'neutral') {
    updateSession(sessionId, (session) => ({
      ...session,
      messages: [...session.messages, { id: makeId('system'), kind: 'system', content, tone }],
    }));
  }

  function appendEventMessage(sessionId, message) {
    updateSession(sessionId, (session) => ({
      ...session,
      messages: [...session.messages, { id: makeId('event'), ...message }],
    }));
  }

  function buildApprovalResponse(request, allowed) {
    const params = request?.params || {};
    const callId = params.callId || params.call_id || params.toolCallId || params.tool_call_id;
    return {
      id: request.requestId,
      // Keep both shapes because Codex approval payloads have changed across surfaces.
      result: {
        decision: allowed ? 'accept' : 'decline',
        approved: allowed,
        ...(callId ? { callId, call_id: callId } : {}),
      },
    };
  }

  function appendChatMessage(sessionId, role, content, header = role === 'user' ? 'You' : 'Codex') {
    const id = makeId('msg');
    updateSession(sessionId, (session) => ({
      ...session,
      messages: [
        ...session.messages,
        {
          id,
          kind: 'chat',
          role,
          header,
          content,
          createdAt: Date.now(),
        },
      ],
    }));
    return id;
  }

  function appendReasoningMessage(sessionId) {
    const id = makeId('reasoning');
    updateSession(sessionId, (session) => ({
      ...session,
      messages: [
        ...session.messages,
        {
          id,
          kind: 'reasoning',
          label: 'Thinking...',
          content: '',
          open: true,
        },
      ],
    }));
    return id;
  }

  function setTyping(sessionId, enabled) {
    updateSession(sessionId, (session) => {
      const messages = session.messages.filter((message) => message.kind !== 'typing');
      return enabled
        ? { ...session, messages: [...messages, { id: makeId('typing'), kind: 'typing' }], typing: true }
        : { ...session, messages, typing: false };
    });
  }

  function patchMessage(sessionId, messageId, updater) {
    updateSession(sessionId, (session) => ({
      ...session,
      messages: session.messages.map((message) =>
        message.id === messageId ? { ...message, ...updater(message) } : message,
      ),
    }));
  }

  async function sendPayload(payload) {
    if (!clientIdRef.current) {
      throw new Error('Bridge session not ready');
    }

    const runtimeToken = shouldUseAdminTokenForRuntime(authState) ? normalizeAdminToken(token) : '';
    const rpcUrl = new URL(withTokenQuery(buildBridgeUrl('/codex-rpc'), runtimeToken));
    rpcUrl.searchParams.set('clientId', clientIdRef.current);
    const response = await fetch(rpcUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: payload,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Bridge RPC failed: ${response.status}`);
    }
  }

  function sendRpc(method, params, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const id = nextIdRef.current++;
      const payload = JSON.stringify({ id, method, params });
      if (!clientIdRef.current) {
        reject(new Error('Bridge not connected'));
        return;
      }
      const timeout = window.setTimeout(() => {
        pendingRequestsRef.current.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeoutMs);
      pendingRequestsRef.current.set(id, { resolve, reject });
      sendPayload(payload).catch((error) => {
        window.clearTimeout(timeout);
        pendingRequestsRef.current.delete(id);
        reject(error);
      });
      pendingRequestsRef.current.set(id, {
        resolve: (result) => {
          window.clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          window.clearTimeout(timeout);
          reject(error);
        },
      });
    });
  }

  function sendNotification(method, params = {}) {
    return sendPayload(JSON.stringify({ method, params }));
  }

  async function validatePath(path) {
    try {
      const result = await sendRpc('fs/readDirectory', { path });
      return !!result?.entries;
    } catch {
      return false;
    }
  }

  async function loadWorkspace(path) {
    try {
      await sendRpc('fs/readDirectory', { path });
      updateActiveSession((session) => ({
        ...session,
        label: shortWorkspaceLabel(path),
        workspace: path,
      }));
    } catch (error) {
      appendSystemMessage(activeSessionIdRef.current, `Cannot read: ${path}`, 'error');
    }
  }

  async function updateThreadList(workspace = activeSession.workspace) {
    try {
      const result = await sendRpc('thread/list', { limit: 50, cwd: workspace });
      updateActiveSession((session) => {
        const nextThreadList = result.data || [];
        const nextActiveThread = nextThreadList.find((thread) => thread.id === session.threadId);
        return {
          ...session,
          threadList: nextThreadList,
          threadStatus: nextActiveThread ? getThreadStatusInfo(nextActiveThread) : session.threadStatus,
        };
      });
    } catch (error) {
      appendSystemMessage(activeSessionIdRef.current, `Thread list error: ${error.message}`, 'error');
    }
  }

  async function browseDirectory(path) {
    setWorkspaceBrowserPath(path);
    setPendingWorkspace(path);
    try {
      const result = await sendRpc('fs/readDirectory', { path });
      const dirs = normalizeFileEntries(result.entries)
        .filter((entry) => entry.type === 'directory')
        .sort((left, right) => left.name.localeCompare(right.name));
      setWorkspaceBrowserEntries(dirs);
    } catch (error) {
      appendSystemMessage(activeSessionIdRef.current, `Browse error: ${error.message}`, 'error');
    }
  }

  async function openWorkspaceBrowser() {
    const path = activeSession.workspace?.startsWith('/') ? activeSession.workspace : '/';
    setWorkspaceModalOpen(true);
    await browseDirectory(path);
  }

  async function confirmWorkspace() {
    setWorkspaceModalOpen(false);
    if (!(await validatePath(pendingWorkspace))) {
      appendSystemMessage(activeSessionIdRef.current, `Invalid path: ${pendingWorkspace}`, 'error');
      return;
    }
    await loadWorkspace(pendingWorkspace);
    await updateThreadList(pendingWorkspace);
    appendSystemMessage(activeSessionIdRef.current, `Workspace set to: ${pendingWorkspace}`, 'success');
  }

  async function switchWorkspace(path) {
    if (!path || path === activeSession.workspace) return;
    if (!(await validatePath(path))) {
      appendSystemMessage(activeSessionIdRef.current, `Invalid path: ${path}`, 'error');
      return;
    }
    await loadWorkspace(path);
    await updateThreadList(path);
    appendSystemMessage(activeSessionIdRef.current, `Workspace set to: ${path}`, 'success');
  }

  async function enableBrowserNotifications() {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      appendSystemMessage(activeSessionIdRef.current, 'Browser notifications are not supported here.', 'error');
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      setSettings((current) => ({ ...current, browserNotifications: true }));
      appendSystemMessage(activeSessionIdRef.current, 'Browser notifications enabled.', 'success');
      notifyBrowser('Codex Bridge', 'Notifications are enabled.');
      return;
    }
    appendSystemMessage(activeSessionIdRef.current, `Notification permission: ${permission}`, 'error');
  }

  async function loadThreadHistory(threadId) {
    try {
      const result = await sendRpc('thread/read', { threadId, includeTurns: true });
      const thread = result.thread;
      if (!thread) {
        appendSystemMessage(activeSessionIdRef.current, 'Failed to load thread', 'error');
        return;
      }

      updateActiveSession((session) => ({
        ...session,
        threadId,
        currentTurnId: null,
        isTurnActive: false,
        turnState: 'idle',
        typing: false,
        loadedThreadBlocked: isThreadBlocked(thread),
        threadStatus: getThreadStatusInfo(thread),
        label: thread.name || thread.preview?.slice(0, 28) || session.label,
        messages: [
          {
            id: makeId('system'),
            kind: 'system',
            tone: 'success',
            content: `Loaded: ${thread.name || thread.preview?.slice(0, 50) || threadId.slice(0, 8)}`,
          },
          ...(isThreadBlocked(thread)
            ? [{
                id: makeId('system'),
                kind: 'system',
                tone: 'error',
                content: 'This saved thread still has an unfinished turn. The next message will start a fresh thread to avoid hanging on the old one.',
              }]
            : []),
          ...flattenTurnItems(thread.turns || []),
        ],
      }));
      setApprovalQueue([]);
      streamRef.current = { agentMessageId: null, reasoningMessageId: null, sessionId: activeSessionIdRef.current };
    } catch (error) {
      appendSystemMessage(activeSessionIdRef.current, `Failed to load history: ${error.message}`, 'error');
    }
  }

  async function startThread() {
    const session = sessionsRef.current.find((item) => item.id === activeSessionIdRef.current);
    const result = await sendRpc('thread/start', {
      model: session.model || 'gpt-5.4-codex',
      cwd: session.workspace,
      approvalPolicy: session.approvalPolicy,
      sandbox: session.sandbox,
      developerInstructions: settings.sessionDeveloperInstructions?.trim() || null,
    });
    updateActiveSession((current) => ({
      ...current,
      threadId: result.thread?.id || current.threadId,
      label: result.thread?.name || current.label,
      loadedThreadBlocked: false,
      threadStatus: getThreadStatusInfo(result.thread),
    }));
    return result.thread?.id;
  }

  async function deleteThread(thread) {
    if (!thread?.id) return;
    const confirmed = window.confirm(`Delete this session?\n\n${thread.name || thread.preview || thread.id}`);
    if (!confirmed) return;

    try {
      const payload = await fetchBridgeJson('/thread-delete', {
        method: 'POST',
        body: JSON.stringify({
          threadId: thread.id,
          sessionPath: thread.path || null,
        }),
      });

      updateActiveSession((session) => {
        const deletedActiveThread = session.threadId === thread.id;
        return {
          ...session,
          threadList: session.threadList.filter((item) => item.id !== thread.id),
          threadId: deletedActiveThread ? null : session.threadId,
          currentTurnId: deletedActiveThread ? null : session.currentTurnId,
          isTurnActive: deletedActiveThread ? false : session.isTurnActive,
          turnState: deletedActiveThread ? 'idle' : session.turnState,
          typing: deletedActiveThread ? false : session.typing,
          loadedThreadBlocked: deletedActiveThread ? false : session.loadedThreadBlocked,
          threadStatus: deletedActiveThread ? { label: 'Idle', tone: 'idle' } : session.threadStatus,
          label: deletedActiveThread ? shortWorkspaceLabel(session.workspace) || 'New thread' : session.label,
          messages: deletedActiveThread
            ? [{ id: makeId('system'), kind: 'system', tone: 'success', content: 'Session deleted.' }]
            : session.messages,
        };
      });
      appendSystemMessage(activeSessionIdRef.current, `Deleted session: ${thread.name || thread.preview || thread.id.slice(0, 8)}`, 'success');
    } catch (error) {
      appendSystemMessage(activeSessionIdRef.current, `Delete failed: ${error.message}`, 'error');
    }
  }

  async function pairCurrentDevice() {
    const trimmedToken = adminTokenInput.trim();
    if (!trimmedToken) {
      appendSystemMessage(activeSessionIdRef.current, 'Admin token is required to pair a new device.', 'error');
      return;
    }

    setDeviceBusy(true);
    try {
      await fetchBridgeJson('/device-pair', {
        method: 'POST',
        body: JSON.stringify({
          deviceName: deviceNameInput.trim() || getSuggestedDeviceName(),
        }),
      }, trimmedToken);
      setToken('');
      await refreshDeviceStatus('');
      await refreshDeviceList(trimmedToken);
      appendSystemMessage(activeSessionIdRef.current, 'This browser is now an allowed device.', 'success');
    } catch (error) {
      appendSystemMessage(activeSessionIdRef.current, `Device pairing failed: ${error.message}`, 'error');
    } finally {
      setDeviceBusy(false);
    }
  }

  async function forgetCurrentDevice() {
    setDeviceBusy(true);
    try {
      await fetchBridgeJson('/device-forget', { method: 'POST' }, token);
      setAuthState({ status: 'unauthorized', mode: null, device: null, isAdmin: false });
      setConnectionStatus('disconnected');
      appendSystemMessage(activeSessionIdRef.current, 'This browser has been forgotten.', 'success');
    } catch (error) {
      appendSystemMessage(activeSessionIdRef.current, `Forget device failed: ${error.message}`, 'error');
    } finally {
      setDeviceBusy(false);
    }
  }

  async function revokeDevice(deviceId) {
    setDeviceBusy(true);
    try {
      await fetchBridgeJson('/device-revoke', {
        method: 'POST',
        body: JSON.stringify({ deviceId }),
      }, adminTokenInput.trim());
      await refreshDeviceList(adminTokenInput.trim());
      if (authState.device?.id === deviceId) {
        await refreshDeviceStatus(token);
      }
      appendSystemMessage(activeSessionIdRef.current, 'Device revoked.', 'success');
    } catch (error) {
      appendSystemMessage(activeSessionIdRef.current, `Revoke failed: ${error.message}`, 'error');
    } finally {
      setDeviceBusy(false);
    }
  }

  async function sendTurn() {
    const text = composerText.trim();
    if (!text) return;
    if (activeSession.isTurnActive) {
      appendSystemMessage(activeSessionIdRef.current, 'Current turn is still running. Finish or reset it before sending a new message.', 'error');
      return;
    }

    setComposerText('');
    appendChatMessage(activeSessionIdRef.current, 'user', text);
    updateActiveSession((session) => ({
      ...session,
      label: session.threadId ? session.label : text.slice(0, 28),
    }));

    let threadId = activeSession.threadId;
    if (activeSession.loadedThreadBlocked) {
      appendSystemMessage(
        activeSessionIdRef.current,
        'Previous thread was still stuck on an unfinished turn. Starting a fresh thread for this follow-up.',
        'neutral',
      );
      threadId = null;
    }
    if (!threadId) {
      threadId = await startThread();
    }
    if (!threadId) return;

    try {
      await sendRpc('turn/start', {
        threadId,
        input: [{ type: 'text', text }],
      });
    } catch (error) {
      appendSystemMessage(activeSessionIdRef.current, `Failed to send turn: ${error.message}`, 'error');
    }
  }

  function handleMessage(data) {
    if (data.id !== undefined && pendingRequestsRef.current.has(data.id)) {
      const request = pendingRequestsRef.current.get(data.id);
      pendingRequestsRef.current.delete(data.id);
      if (data.error) {
        request.reject(new Error(data.error.message || JSON.stringify(data.error)));
      } else {
        request.resolve(data.result);
      }
      return;
    }

    const method = data.method;
    const params = data.params || {};
    const sessionId = activeSessionIdRef.current;
    if (method) {
      pushDebug('rpc event', method);
    }

    if (method === 'thread/started') {
      updateActiveSession((session) => ({
        ...session,
        threadId: params.thread?.id || session.threadId,
        label: params.thread?.name || params.thread?.preview?.slice(0, 28) || session.label,
        threadStatus: getThreadStatusInfo(params.thread),
      }));
      appendSystemMessage(sessionId, 'Thread started', 'success');
      updateThreadList();
      return;
    }

    if (method === 'thread/status/changed') {
      updateActiveSession((session) => ({
        ...session,
        threadStatus: getThreadStatusInfo({ status: params.status, turns: session.currentTurnId ? [{ status: 'inProgress' }] : [] }),
        threadList: session.threadList.map((thread) =>
          thread.id === params.threadId ? { ...thread, status: params.status } : thread,
        ),
      }));
      return;
    }

    if (method === 'thread/name/updated') {
      updateActiveSession((session) => ({
        ...session,
        label: params.name || params.title || session.label,
      }));
      appendSystemMessage(sessionId, `Thread named: "${params.name || params.title || 'unnamed'}"`, 'neutral');
      return;
    }

    if (method === 'turn/started') {
      streamRef.current = { agentMessageId: null, reasoningMessageId: null, sessionId };
      updateActiveSession((session) => ({
        ...session,
        currentTurnId: params.turn?.id,
        isTurnActive: true,
        turnState: 'running',
        threadStatus: { label: 'Running', tone: 'running' },
      }));
      setTyping(sessionId, true);
      return;
    }

    if (method === 'turn/completed') {
      streamRef.current = { agentMessageId: null, reasoningMessageId: null, sessionId };
      updateActiveSession((session) => ({
        ...session,
        currentTurnId: null,
        isTurnActive: false,
        turnState: params.turn?.status === 'completed' ? 'done' : 'error',
        threadStatus: params.turn?.error ? { label: 'Error', tone: 'error' } : { label: 'Completed', tone: 'done' },
      }));
      setTyping(sessionId, false);
      if (params.turn?.error) {
        appendSystemMessage(sessionId, `Error: ${params.turn.error.message}`, 'error');
        notifyBrowser('Codex turn failed', params.turn.error.message);
      } else {
        notifyBrowser('Codex turn completed', activeThread?.name || activeSession.label || 'A turn finished.');
      }
      return;
    }

    if (method === 'item/started') {
      const item = params.item || {};
      if (item.type === 'agentMessage') {
        setTyping(sessionId, false);
        streamRef.current.agentMessageId = appendChatMessage(sessionId, 'agent', '');
        streamRef.current.sessionId = sessionId;
      } else if (item.type === 'reasoning') {
        setTyping(sessionId, false);
        streamRef.current.reasoningMessageId = appendReasoningMessage(sessionId);
        streamRef.current.sessionId = sessionId;
      } else if (item.type === 'commandExecution') {
        appendEventMessage(sessionId, {
          kind: 'command',
          status: item.status || 'running',
          command: item.command?.slice(0, 280) || 'Running command...',
        });
      } else if (item.type === 'contextCompaction') {
        appendSystemMessage(sessionId, '📦 Compacting context...', 'neutral');
      } else if (item.type === 'fileChange') {
        if ((item.changes || []).length) {
          appendEventMessage(sessionId, {
            kind: 'file-change',
            changes: item.changes || [],
          });
        }
      }
      return;
    }

    if (method === 'item/agentMessage/delta' && params.delta && streamRef.current.agentMessageId) {
      patchMessage(streamRef.current.sessionId, streamRef.current.agentMessageId, (message) => ({
        content: `${message.content}${params.delta}`,
      }));
      return;
    }

    if ((method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') && params.delta && streamRef.current.reasoningMessageId) {
      patchMessage(streamRef.current.sessionId, streamRef.current.reasoningMessageId, (message) => ({
        content: `${message.content}${params.delta}`,
      }));
      return;
    }

    if (method === 'item/completed' && streamRef.current.reasoningMessageId) {
      patchMessage(streamRef.current.sessionId, streamRef.current.reasoningMessageId, () => ({
        label: 'Thought process',
      }));
      return;
    }

    if (
      method === 'item/commandExecution/requestApproval' ||
      method === 'item/fileChange/requestApproval' ||
      method === 'item/permissions/requestApproval'
    ) {
      const summary = params.command
        || params.toolName
        || params.path
        || params.reason
        || 'Review the requested action and decide whether to allow it.';
      appendEventMessage(sessionId, {
        kind: 'approval',
        summary,
      });
      notifyBrowser('Approval needed', summary);
      setApprovalQueue((current) => [...current, { requestId: data.id, params }]);
      return;
    }

    if (method === 'error') {
      appendSystemMessage(sessionId, `❌ ${params.error?.message || params.message || 'Unknown error'}`, 'error');
      notifyBrowser('Codex bridge error', params.error?.message || params.message || 'Unknown error');
    }
  }

  function respondApproval(allowed) {
    if (!approvalRequest || !clientIdRef.current) {
      setApprovalQueue((current) => current.slice(1));
      return;
    }

    const payload = buildApprovalResponse(approvalRequest, allowed);
    appendSystemMessage(
      activeSessionIdRef.current,
      allowed ? 'Approval accepted. Waiting for Codex to continue...' : 'Approval denied.',
      allowed ? 'neutral' : 'error',
    );
    sendPayload(JSON.stringify(payload)).catch((error) => {
      appendSystemMessage(activeSessionIdRef.current, `Approval response failed: ${error.message}`, 'error');
    });
    setApprovalQueue((current) => current.slice(1));
  }

  function handleComposerKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendTurn();
    }
  }

  function handleComposerChange(event) {
    setComposerText(event.target.value);
    event.target.style.height = 'auto';
    event.target.style.height = `${Math.min(event.target.scrollHeight, 150)}px`;
  }

  function handleCopyClick(event) {
    const button = event.target.closest('.code-copy');
    if (!button) return;

    const text = button.dataset.copy || '';
    navigator.clipboard.writeText(text).then(() => {
      button.classList.add('copied');
      button.textContent = 'Copied';
      window.setTimeout(() => {
        button.classList.remove('copied');
        button.textContent = 'Copy';
      }, 1400);
    });
  }

  function toggleReasoning(messageId) {
    patchMessage(activeSessionIdRef.current, messageId, (message) => ({ open: !message.open }));
  }

  const modelBadge = activeSession.model || modelOptions[0]?.name || '';
  const filteredThreads = activeSession.threadList.filter((thread) => {
    const haystack = `${thread.preview || ''} ${thread.name || ''}`.toLowerCase();
    return haystack.includes(threadFilter.trim().toLowerCase());
  });
  const workspaceChoices = buildWorkspaceList(activeSession.workspace, recentWorkspaces);
  const activeThread = activeSession.threadList.find((thread) => thread.id === activeSession.threadId);
  const sessionStatus = activeThread ? getThreadStatusInfo(activeThread) : activeSession.threadStatus;
  const turnLabel = activeSession.turnState === 'running' ? 'Running' : activeSession.turnState === 'done' ? 'Done' : activeSession.turnState === 'error' ? 'Error' : 'Idle';
  const bridgeLabel = connectionStatus === 'connected' ? 'Bridge on' : connectionStatus === 'connecting' ? 'Bridge connecting' : 'Bridge off';
  const showTurnLabel = activeSession.turnState !== 'idle';
  const { quickCommand: cfQuickCommand, namedCommand: cfNamedCommand } = buildTunnelCommands(settings);
  const adminTokenReady = Boolean(adminTokenInput.trim());
  const devicePaired = authState.status === 'authorized' && authState.mode === 'device';
  const needsPairing = authState.status !== 'checking' && !devicePaired;
  const deviceMatchLabel = devicePaired
    ? 'matched'
    : authState.status === 'authorized'
      ? 'token only'
      : authState.status === 'checking'
        ? 'checking'
        : 'not matched';
  const deviceStatusLabel = authState.status === 'authorized'
    ? authState.device?.name || (authState.mode === 'token' ? 'Admin token session' : 'Allowed device')
    : authState.status === 'checking'
      ? 'Checking device...'
      : 'Device not paired';
  return (
    <div className={`bridge-root${sidebarOpen ? ' sidebar-visible' : ''}${isMobileViewport ? ' mobile-viewport' : ''}`} onClickCapture={handleCopyClick}>
      <div className={`mobile-overlay ${sidebarOpen ? 'active' : ''}`} onClick={() => setSidebarOpen(false)} />

      <div id="sidebar" className={sidebarOpen ? 'open' : ''}>
        <div className="sidebar-header">
          <div className="logo">History</div>
          <button aria-label="Close history" className="mobile-close-btn" onClick={() => setSidebarOpen(false)} type="button">×</button>
        </div>

        <div className="sidebar-scrollable">
          <div className="sidebar-section">
            <div className="section-head">
              <h3>Threads</h3>
              <div className="section-actions">
                <button id="btn-new-thread" onClick={resetCurrentThread} title="New Thread" type="button">＋</button>
              <button className="icon-btn" onClick={() => updateThreadList()} title="Refresh" type="button">↻</button>
              </div>
            </div>
            <input
              className="section-input"
              onChange={(event) => setThreadFilter(event.target.value)}
              placeholder="Filter threads..."
              type="text"
              value={threadFilter}
            />
            <div id="thread-list">
              {filteredThreads.length === 0 ? (
                <div className="thread-empty">No threads yet</div>
              ) : (
                filteredThreads.map((thread) => (
                  <div
                    key={thread.id}
                    className={`thread-item${thread.id === activeSession.threadId ? ' active' : ''}`}
                    onClick={() => {
                      loadThreadHistory(thread.id);
                      if (isMobileViewport) setSidebarOpen(false);
                    }}
                  >
                    <div className="thread-title">{thread.preview?.slice(0, 40) || thread.name || 'unnamed'}</div>
                    <div className="thread-meta">
                      <span>{getThreadStatusInfo(thread).label}</span>
                      <span>{formatDate(thread.updatedAt)}</span>
                    </div>
                    <div className="thread-meta">
                      <button
                        className="icon-btn"
                        onClick={(event) => {
                          event.stopPropagation();
                          deleteThread(thread);
                        }}
                        title="Delete Session"
                        type="button"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div id="workspace-section" className="sidebar-section">
            <div className="section-head">
              <h3>Workspace</h3>
              <div className="section-actions">
                <button
                  className="icon-btn"
                  onClick={() => setSidebarWorkspaceCollapsed((value) => !value)}
                  title={sidebarWorkspaceCollapsed ? 'Expand Workspace' : 'Collapse Workspace'}
                  type="button"
                >
                  {sidebarWorkspaceCollapsed ? '▸' : '▾'}
                </button>
                <button className="icon-btn" onClick={openWorkspaceBrowser} title="Change Workspace" type="button">↗</button>
              </div>
            </div>
            {!sidebarWorkspaceCollapsed ? (
              <>
                <div id="workspace-path" title="Click to browse" onClick={openWorkspaceBrowser}>
                  {activeSession.workspace}
                </div>
                <div className="workspace-list">
                  {workspaceChoices.map((workspace) => (
                    <button
                      key={workspace}
                      className={`workspace-link${workspace === activeSession.workspace ? ' active' : ''}`}
                      onClick={() => switchWorkspace(workspace)}
                      type="button"
                    >
                      {shortWorkspaceLabel(workspace)}
                    </button>
                  ))}
                </div>
              </>
            ) : null}
          </div>

        </div>

        <div className="sidebar-footer">
          <div className="status-shell">
            <div id="status-dot" className={connectionStatus} />
            <span id="status-text">{connectionStatus}</span>
          </div>
          <button className="settings-btn icon-only" onClick={() => setSettingsOpen(true)} title="Settings" type="button">⚙</button>
        </div>
      </div>

      <div id="chat-area">
        <div id="top-bar">
          <div className="top-bar-main">
            <button aria-label="Open history" className="mobile-menu-btn" onClick={() => setSidebarOpen(true)} type="button">☰</button>
            <button aria-label="Toggle history" className="desktop-menu-btn" onClick={() => setSidebarOpen((value) => !value)} type="button">≡</button>
            <div className="top-bar-copy">
              <div className="top-bar-title-row">
                <strong>{activeThread?.name || activeThread?.preview?.slice(0, 44) || 'New thread'}</strong>
                <span className="top-model-chip">{modelBadge}</span>
              </div>
              <span>{shortWorkspaceLabel(activeSession.workspace)}</span>
            </div>
          </div>
          <div className="top-bar-actions">
            <span className={`top-meta bridge-flag ${connectionStatus}`}>{bridgeLabel}</span>
            {devicePaired ? <span className="paired-badge">Paired</span> : null}
            <span className={`top-meta top-state ${authState.status === 'authorized' ? 'done' : authState.status === 'checking' ? 'running' : 'error'}`}>{deviceStatusLabel}</span>
            <span className={`top-meta top-state ${sessionStatus.tone}`}>{sessionStatus.label}</span>
            {showTurnLabel ? <span className={`top-meta top-state ${activeSession.turnState}`}>{turnLabel}</span> : null}
            {activeThread ? (
              <button className="top-icon" onClick={() => deleteThread(activeThread)} title="Delete Session" type="button">⌫</button>
            ) : null}
            <button className={`top-icon${debugOpen ? ' active' : ''}`} onClick={() => setDebugOpen((value) => !value)} type="button" title="Debug">⋯</button>
          </div>
        </div>

        <div id="messages">
          {activeSession.messages.length === 0 ? (
            <div className="empty-state">
              <h2>One thread. One input.</h2>
              {!needsPairing ? (
                <>
                  <p>History and workspace are in the left panel.</p>
                  <div className="empty-actions">
                    {PROMPT_SUGGESTIONS.slice(0, 2).map((prompt) => (
                      <button
                        key={prompt}
                        className="text-action"
                        onClick={() => {
                          setComposerText(prompt);
                          composerRef.current?.focus();
                        }}
                        type="button"
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <div className="auth-panel">
                  <p>当前只是管理员 token 临时放行。点一次配对，把这台浏览器登记成允许设备，之后就不用再带 token 了。</p>
                  <div className="setting-group">
                    <label htmlFor="pair-device-name">Device name</label>
                    <input
                      id="pair-device-name"
                      type="text"
                      value={deviceNameInput}
                      onChange={(event) => setDeviceNameInput(event.target.value)}
                      placeholder="MacBook Safari"
                    />
                  </div>
                  <div className="setting-group">
                    <label htmlFor="pair-admin-token">Admin token</label>
                    <input
                      id="pair-admin-token"
                      type="text"
                      value={adminTokenInput}
                      onChange={(event) => setAdminTokenInput(event.target.value)}
                      placeholder="Paste once to pair this device"
                    />
                  </div>
                  <div className="empty-actions">
                    <button className="settings-button" onClick={pairCurrentDevice} disabled={!adminTokenReady || deviceBusy} type="button">
                      Pair this browser
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            activeSession.messages.map((message) => (
              <MessageItem key={message.id} message={message} onToggleReasoning={toggleReasoning} />
            ))
          )}
          <div ref={messagesEndRef} style={{ height: '24px' }} />
        </div>

        <div id="input-area">
          <div id="composer-shell">
            <textarea
              id="prompt-input"
              ref={composerRef}
              placeholder={connectionStatus === 'connected' ? "Ask Codex anything..." : "Connecting to bridge..."}
              rows={1}
              value={composerText}
              onChange={handleComposerChange}
              onKeyDown={handleComposerKeyDown}
              disabled={connectionStatus !== 'connected'}
            />
            <div id="composer-meta">
              <div className="composer-controls">
                <select
                  id="model-select"
                  value={activeSession.model}
                  onChange={(event) => updateActiveSession((session) => ({ ...session, model: event.target.value }))}
                >
                  {(modelOptions.length ? modelOptions : [{ name: 'gpt-4o-codex', displayName: 'gpt-4o-codex' }]).map((model) => (
                    <option key={model.name || model.id} value={model.name || model.id}>
                      {model.displayName || model.name || model.id}
                    </option>
                  ))}
                </select>
                <select
                  id="approval-select"
                  value={activeSession.approvalPolicy}
                  onChange={(event) => updateActiveSession((session) => ({ ...session, approvalPolicy: event.target.value }))}
                >
                  <option value="on-request">on-request</option>
                  <option value="untrusted">untrusted</option>
                  <option value="never">never</option>
                </select>
                <div className={`composer-workspace${workspaceCollapsed ? ' collapsed' : ''}`}>
                  <button
                    className="composer-collapse"
                    onClick={() => setWorkspaceCollapsed((value) => !value)}
                    title={workspaceCollapsed ? 'Expand Workspace' : 'Collapse Workspace'}
                    type="button"
                  >
                    {workspaceCollapsed ? '▸' : '▾'}
                  </button>
                  <button
                    className="composer-path"
                    onClick={openWorkspaceBrowser}
                    title={activeSession.workspace}
                    type="button"
                  >
                    {workspaceCollapsed ? '⌂' : shortWorkspaceLabel(activeSession.workspace)}
                  </button>
                </div>
              </div>
              <div className="composer-actions">
                <span>Enter to send</span>
                <button id="btn-send" disabled={connectionStatus !== 'connected' || activeSession.isTurnActive} onClick={sendTurn} type="button">
                  Send
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {approvalRequest ? (
        <div id="approval-modal" className="show">
          <div id="approval-box">
            <h3>⚠️ Approval Required</h3>
            <pre>{JSON.stringify(approvalRequest.params, null, 2)}</pre>
            <div className="actions">
              <button className="deny" onClick={() => respondApproval(false)} type="button">
                Deny
              </button>
              <button className="allow" onClick={() => respondApproval(true)} type="button">
                Allow
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {debugOpen ? (
        <div id="debug-modal" className="show" onClick={() => setDebugOpen(false)}>
          <div id="debug-box" onClick={(event) => event.stopPropagation()}>
            <div className="debug-panel-header">
              <strong>Debug</strong>
              <span>status={connectionStatus} client={clientIdRef.current || 'none'}</span>
            </div>
            <div className="debug-panel-body">
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '8px' }}>
                <button className="debug-clear" onClick={() => setDebugEvents([])} type="button">Clear</button>
              </div>
              {debugEvents.length === 0 ? (
                <div className="debug-line muted">No events yet</div>
              ) : (
                debugEvents.map((line, index) => <div className="debug-line" key={`${line}-${index}`}>{line}</div>)
              )}
            </div>
          </div>
        </div>
      ) : null}

      {settingsOpen ? (
        <div id="settings-modal" className="show">
          <div id="settings-box">
            <div className="modal-head">
              <h3>Settings</h3>
              <button className="modal-close" onClick={() => setSettingsOpen(false)} type="button" aria-label="Close settings">
                ×
              </button>
            </div>
            <div className="settings-body">
              <div className="settings-section">
                <div className="settings-title">设备</div>
                <div className="auth-panel">
                  <div className="auth-summary">
                    <strong>
                      {devicePaired ? 'Allowed device' : 'Pair required'}
                      {devicePaired ? <span className="paired-badge inline">Paired</span> : null}
                    </strong>
                    <span>
                      {devicePaired
                        ? `${authState.device?.name || 'Current browser'} · cookie auth`
                        : authState.status === 'authorized'
                          ? `${authState.device?.name || 'Current browser'} · admin token only`
                          : 'Only paired devices can connect.'}
                    </span>
                  </div>
                  <div className="device-meta-grid">
                    <div className="device-meta-item">
                      <span className="device-meta-label">Device</span>
                      <strong>{authState.device?.name || deviceNameInput || 'Current browser'}</strong>
                    </div>
                    <div className="device-meta-item">
                      <span className="device-meta-label">Match</span>
                      <strong className={`device-match ${devicePaired ? 'ok' : authState.status === 'authorized' ? 'warn' : 'off'}`}>
                        {deviceMatchLabel}
                      </strong>
                    </div>
                  </div>
                  <div className="setting-group">
                    <label htmlFor="settings-device-name">Device name</label>
                    <input
                      id="settings-device-name"
                      type="text"
                      value={deviceNameInput}
                      onChange={(event) => setDeviceNameInput(event.target.value)}
                      placeholder="MacBook Safari"
                    />
                  </div>
                  <div className="setting-group">
                    <label htmlFor="settings-admin-token">Admin token</label>
                    <input
                      id="settings-admin-token"
                      type="text"
                      value={adminTokenInput}
                      onChange={(event) => setAdminTokenInput(event.target.value)}
                      placeholder="Needed only for pairing or device management"
                    />
                  </div>
                  <div className="settings-inline-actions">
                    <button className="settings-button" disabled={!adminTokenReady || deviceBusy} onClick={pairCurrentDevice} type="button">
                      Pair this browser
                    </button>
                    <button className="settings-button" disabled={authState.status !== 'authorized' || deviceBusy} onClick={forgetCurrentDevice} type="button">
                      Forget this browser
                    </button>
                    <button className="settings-button" disabled={!adminTokenReady || deviceBusy} onClick={() => refreshDeviceList(adminTokenInput.trim())} type="button">
                      Refresh devices
                    </button>
                  </div>
                  {deviceList.length > 0 ? (
                    <div className="device-list">
                      {deviceList.map((device) => (
                        <div className="device-item" key={device.id}>
                          <div className="device-copy">
                            <strong>{device.name}</strong>
                            <span>Last seen {device.lastSeenAt ? formatDate(device.lastSeenAt) : 'never'}</span>
                          </div>
                          <button className="settings-button" disabled={deviceBusy} onClick={() => revokeDevice(device.id)} type="button">
                            Revoke
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="settings-help">Pair one device, then daily access runs on device cookies instead of URL token.</div>
                  )}
                </div>
              </div>

              <div className="settings-section">
                <div className="settings-title">Session Prompt</div>
                <div className="setting-group">
                  <label htmlFor="session-developer-instructions">Developer Instructions</label>
                  <textarea
                    id="session-developer-instructions"
                    className="settings-textarea"
                    onChange={(event) => setSettings((current) => ({ ...current, sessionDeveloperInstructions: event.target.value }))}
                    placeholder="Inject custom session instructions at the developer/system layer for new threads."
                    rows={6}
                    value={settings.sessionDeveloperInstructions}
                  />
                </div>
                <div className="settings-help">
                  Applied as <code>developerInstructions</code> when a new thread starts. Existing threads keep their current instructions.
                </div>
              </div>

              <div className="settings-section">
                <div className="settings-title">Runtime</div>
                <div className="setting-group">
                  <label htmlFor="settings-model-select">Model</label>
                  <select
                    id="settings-model-select"
                    value={activeSession.model}
                    onChange={(event) => updateActiveSession((session) => ({ ...session, model: event.target.value }))}
                  >
                    {(modelOptions.length ? modelOptions : [{ name: 'gpt-4o-codex', displayName: 'gpt-4o-codex' }]).map((model) => (
                      <option key={model.name || model.id} value={model.name || model.id}>
                        {model.displayName || model.name || model.id}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="setting-group">
                  <label htmlFor="settings-sandbox-select">Sandbox</label>
                  <select
                    id="settings-sandbox-select"
                    value={activeSession.sandbox}
                    onChange={(event) => updateActiveSession((session) => ({ ...session, sandbox: event.target.value }))}
                  >
                    <option value="workspace-write">workspace-write</option>
                    <option value="read-only">read-only</option>
                    <option value="danger-full-access">danger-full-access</option>
                  </select>
                </div>
                <div className="setting-group">
                  <label htmlFor="settings-approval-select">Approval</label>
                  <select
                    id="settings-approval-select"
                    value={activeSession.approvalPolicy}
                    onChange={(event) => updateActiveSession((session) => ({ ...session, approvalPolicy: event.target.value }))}
                  >
                    <option value="on-request">on-request</option>
                    <option value="untrusted">untrusted</option>
                    <option value="never">never</option>
                  </select>
                </div>
              </div>

              <div className="settings-section">
                <div className="settings-title">Environment Capabilities</div>
                <div className="capability-list">
                  <div className="capability-item">
                    <span className={`capability-dot ${capabilities.codexRpc.available ? 'ok' : 'off'}`} />
                    <div className="capability-copy">
                      <strong>Codex RPC</strong>
                      <span>{capabilities.codexRpc.transport || 'Unavailable'} {capabilities.codexRpc.target ? `· ${capabilities.codexRpc.target}` : ''}</span>
                    </div>
                  </div>
                  <div className="capability-item">
                    <span className={`capability-dot ${capabilities.screenshot.available ? 'ok' : 'off'}`} />
                    <div className="capability-copy">
                      <strong>Screenshot</strong>
                      <span>{capabilities.screenshot.available ? capabilities.screenshot.path : 'screencapture not found'}</span>
                    </div>
                  </div>
                  <div className="capability-item">
                    <span className={`capability-dot ${capabilities.playwright.available ? 'ok' : 'off'}`} />
                    <div className="capability-copy">
                      <strong>Playwright</strong>
                      <span>{capabilities.playwright.available ? capabilities.playwright.path : 'playwright not found'}</span>
                    </div>
                  </div>
                  <div className="capability-item">
                    <span className={`capability-dot ${capabilities.cloudflared.available ? 'ok' : 'off'}`} />
                    <div className="capability-copy">
                      <strong>Cloudflare Tunnel</strong>
                      <span>{capabilities.cloudflared.available ? capabilities.cloudflared.path : 'cloudflared not found'}</span>
                    </div>
                  </div>
                  <div className="capability-item">
                    <span className={`capability-dot ${capabilities.git.available ? 'ok' : 'off'}`} />
                    <div className="capability-copy">
                      <strong>Git</strong>
                      <span>{capabilities.git.available ? capabilities.git.path : 'git not found'}</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="settings-section">
                <div className="settings-title">Permissions</div>
                <label className="settings-toggle">
                  <input
                    checked={settings.autoApproveAll}
                    onChange={(event) => setSettings((current) => ({ ...current, autoApproveAll: event.target.checked }))}
                    type="checkbox"
                  />
                  <span>All Accept</span>
                </label>
                <div className="settings-help">
                  Automatically approves incoming permission requests in this browser thread view.
                </div>
              </div>

              <div className="settings-section">
                <div className="settings-title">Browser Hooks</div>
                <label className="settings-toggle">
                  <input
                    checked={settings.browserNotifications}
                    onChange={(event) => setSettings((current) => ({ ...current, browserNotifications: event.target.checked }))}
                    type="checkbox"
                  />
                  <span>Browser Notifications</span>
                </label>
                <div className="settings-help">
                  Sends local browser notifications for approval prompts, turn completion, and bridge errors.
                </div>
                <button className="header-action settings-button" onClick={enableBrowserNotifications} type="button">
                  Request Notification Permission
                </button>
              </div>

              <div className="settings-section">
                <div className="settings-title">Cloudflare Tunnel</div>
                <input
                  className="settings-input"
                  onChange={(event) => setSettings((current) => ({ ...current, cfTunnelName: event.target.value }))}
                  placeholder="Tunnel name"
                  type="text"
                  value={settings.cfTunnelName}
                />
                <input
                  className="settings-input"
                  onChange={(event) => setSettings((current) => ({ ...current, cfTunnelDomain: event.target.value }))}
                  placeholder="Hostname, e.g. codex.example.com"
                  type="text"
                  value={settings.cfTunnelDomain}
                />
                <input
                  className="settings-input"
                  onChange={(event) => setSettings((current) => ({ ...current, cfTunnelUrl: event.target.value }))}
                  placeholder="Local URL"
                  type="text"
                  value={settings.cfTunnelUrl}
                />
                <input
                  className="settings-input"
                  onChange={(event) => setSettings((current) => ({ ...current, cfTunnelConfigPath: event.target.value }))}
                  placeholder="cloudflared config path"
                  type="text"
                  value={settings.cfTunnelConfigPath}
                />
                <input
                  className="settings-input"
                  onChange={(event) => setSettings((current) => ({ ...current, cfTunnelId: event.target.value }))}
                  placeholder="Tunnel ID (reserved)"
                  type="text"
                  value={settings.cfTunnelId}
                />
                <div className="settings-help">
                  Quick tunnel:
                </div>
                <pre className="settings-code">{cfQuickCommand}</pre>
                <div className="settings-help">
                  Named tunnel:
                </div>
                <pre className="settings-code">{cfNamedCommand}</pre>
                <div className="settings-help">
                  The tunnel should point at the frontend URL only. Bridge traffic is proxied through this app.
                </div>
              </div>
            </div>

            <div className="actions settings-actions">
              <button className="allow" onClick={() => setSettingsOpen(false)} type="button">
                Done
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {workspaceModalOpen ? (
        <div id="workspace-modal" className="show">
          <div id="workspace-box">
            <h3>📂 Select Workspace</h3>
            <div id="workspace-quick-select">
              <div className="quick-select-title">Trusted Projects</div>
              <div className="quick-select-list">
                {TRUSTED_PROJECTS.map((project) => {
                  const name = project.split('/').pop() || project;
                  const active = project === pendingWorkspace;
  return (
                    <button
                      key={project}
                      className={`text-action${active ? ' active-chip' : ''}`}
                      onClick={() => browseDirectory(project)}
                      type="button"
                    >
                      {name}
                    </button>
                  );
                })}
              </div>
            </div>
            <div id="workspace-breadcrumb">{workspaceBrowserPath}</div>
            <div id="workspace-dir-list">
              {workspaceBrowserPath !== '/' ? (
                <div className="dir-item" onClick={() => browseDirectory(workspaceBrowserPath.split('/').slice(0, -1).join('/') || '/')}>
                  <span>..</span>
                </div>
              ) : null}
              {workspaceBrowserEntries.map((entry) => {
                const fullPath = workspaceBrowserPath === '/' ? `/${entry.name}` : `${workspaceBrowserPath}/${entry.name}`;
                const trusted = TRUSTED_PROJECTS.some((project) => fullPath === project || fullPath.startsWith(`${project}/`));
  return (
                  <div key={fullPath} className="dir-item" onClick={() => browseDirectory(fullPath)}>
                    <span>{entry.name}</span>
                    {trusted ? <span className="trusted-badge">✓</span> : null}
                  </div>
                );
              })}
            </div>
            <div className="actions">
              <button className="deny" onClick={() => setWorkspaceModalOpen(false)} type="button">
                Cancel
              </button>
              <button className="allow" onClick={confirmWorkspace} type="button">
                Select This
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
