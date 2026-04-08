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
    fileTreeRoot: workspace,
    fileTreeEntries: [],
    folderContents: {},
    expandedFolders: {},
    model: '',
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    typing: false,
  };
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
    return <div className={`msg system${message.tone === 'error' ? ' error' : message.tone === 'success' ? ' success' : ''}`}>{message.content}</div>;
  }

  if (message.kind === 'command') {
  return (
      <div className="event-card command-card">
        <div className="event-card-header">
          <span className={`event-badge ${message.status || 'running'}`}>{message.status || 'running'}</span>
          <span className="event-title">Command Execution</span>
        </div>
        <div className="event-command">{message.command}</div>
      </div>
    );
  }

  if (message.kind === 'file-change') {
  return (
      <div className="event-card file-card">
        <div className="event-card-header">
          <span className="event-badge neutral">{message.changes?.length || 0} files</span>
          <span className="event-title">File Changes</span>
        </div>
        <div className="event-file-list">
          {(message.changes || []).map((change, index) => (
            <div className="event-file-item" key={`${change.path || 'change'}-${index}`}>
              <span className={`change-type ${change.type || 'update'}`}>
                {change.type === 'add' ? 'ADD' : change.type === 'delete' ? 'DEL' : 'MOD'}
              </span>
              <span className="change-path">{change.path}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (message.kind === 'approval') {
  return (
      <div className="event-card approval-card">
        <div className="event-card-header">
          <span className="event-badge pending">approval</span>
          <span className="event-title">Pending Approval</span>
        </div>
        <div className="event-approval-copy">{message.summary || 'Waiting for approval decision.'}</div>
      </div>
    );
  }

  if (message.kind === 'reasoning') {
  return (
      <div className="msg-wrapper reasoning-block">
        <div className="msg-card">
          <button className="reasoning-toggle" onClick={() => onToggleReasoning(message.id)} type="button">
            <span className={`arrow${message.open ? ' open' : ''}`}>▶</span>
            <span>{message.label || 'Thought process'}</span>
          </button>
          <div className={`reasoning-content${message.open ? ' visible' : ''}`}>{message.content}</div>
        </div>
      </div>
    );
  }

  if (message.kind === 'typing') {
  return (
      <div className="msg-wrapper agent">
        <div className="msg-card">
          <div className="msg-header">
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
    <div className={`msg-wrapper ${message.role}`}>
      <div className="msg-card">
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

function FileTree({ entries, rootPath, folderContents, expandedFolders, onToggleFolder }) {
  if (!entries?.length) {
    return <div className="tree-empty">Empty</div>;
  }

  return entries.map((entry) => {
    const fullPath = rootPath ? `${rootPath.replace(/\/$/, '')}/${entry.name}` : entry.name;
    const isDirectory = entry.type === 'directory';
    const isExpanded = expandedFolders[fullPath];
    const children = folderContents[fullPath] || [];
  return (
      <div key={fullPath}>
        <div
          className={`tree-item ${isDirectory ? 'folder' : 'file'}`}
          onClick={() => isDirectory && onToggleFolder(fullPath)}
        >
          <span>{isDirectory ? '📁' : '📄'}</span>
          <span>{entry.name}</span>
        </div>
        {isDirectory && isExpanded ? (
          <div className="tree-children">
            <FileTree
              entries={children}
              rootPath={fullPath}
              folderContents={folderContents}
              expandedFolders={expandedFolders}
              onToggleFolder={onToggleFolder}
            />
          </div>
        ) : null}
      </div>
    );
  });
}

export default function CodexBridgeApp() {
  const initialSession = useRef(createSession(DEFAULT_WORKSPACE)).current;
  const [hydrated, setHydrated] = useState(false);
  const [debugEvents, setDebugEvents] = useState([]);
  const [sessions, setSessions] = useState([initialSession]);
  const [activeSessionId, setActiveSessionId] = useState(initialSession.id);
  const [connectionStatus, setConnectionStatus] = useState('disconnected');
  const [composerText, setComposerText] = useState('');
  const [modelOptions, setModelOptions] = useState([]);
  const [token, setToken] = useState(DEFAULT_BRIDGE_TOKEN);
  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false);
  const [workspaceBrowserPath, setWorkspaceBrowserPath] = useState('/');
  const [workspaceBrowserEntries, setWorkspaceBrowserEntries] = useState([]);
  const [pendingWorkspace, setPendingWorkspace] = useState(DEFAULT_WORKSPACE);
  const [approvalRequest, setApprovalRequest] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
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
  const activeSessionIdRef = useRef(activeSessionId);
  const sessionsRef = useRef(sessions);
  const streamRef = useRef({ agentMessageId: null, reasoningMessageId: null, sessionId: activeSessionId });
  const messagesEndRef = useRef(null);
  const composerRef = useRef(null);

  const activeSession = sessions.find((session) => session.id === activeSessionId) || sessions[0];

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
    const params = new URLSearchParams(window.location.search);
    const nextToken = getInitialBridgeToken();
    const cwd = params.get('cwd') || DEFAULT_WORKSPACE;
    pushDebug('boot params', `token=${nextToken ? 'present' : 'missing'} cwd=${cwd}`);
    setToken(nextToken);
    setPendingWorkspace(cwd);
    setSessions((prev) => prev.map((session) => (session.id === activeSessionIdRef.current ? { ...session, workspace: cwd, fileTreeRoot: cwd } : session)));
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

  useEffect(() => {
    if (!hydrated || !token) return undefined;

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
      const source = new window.EventSource(`${buildBridgeUrl('/codex-events')}?token=${encodeURIComponent(token)}`);
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
          appendSystemMessage(activeSessionIdRef.current, 'Connected', 'success');

          try {
            pushDebug('rpc initialize', 'request');
            await sendRpc('initialize', {
              clientInfo: { name: 'codex_bridge_next', title: 'Codex Bridge Next UI', version: '2.0.0' },
            });
            pushDebug('rpc initialize', 'ok');
            await sendNotification('initialized');
            pushDebug('rpc initialized', 'notification sent');
            appendSystemMessage(activeSessionIdRef.current, 'Initialized', 'success');

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
  }, [hydrated, token]);

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

  function createNewSession(workspace = activeSession.workspace) {
    const session = createSession(workspace, makeId('session'));
    setSessions((prev) => [...prev, session]);
    setActiveSessionId(session.id);
  }

  function closeSession(sessionId) {
    if (sessions.length === 1) {
      updateSession(sessionId, (session) => ({
        ...session,
        threadId: null,
        currentTurnId: null,
        isTurnActive: false,
        turnState: 'idle',
        messages: [],
      }));
      return;
    }

    const nextSessions = sessions.filter((session) => session.id !== sessionId);
    const fallback = nextSessions[Math.max(0, nextSessions.findIndex((session) => session.id === activeSessionId) - 1)] || nextSessions[0];
    setSessions(nextSessions);
    if (activeSessionId === sessionId && fallback) {
      setActiveSessionId(fallback.id);
    }
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

    const response = await fetch(`${buildBridgeUrl('/codex-rpc')}?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientIdRef.current)}`, {
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

  function sendRpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextIdRef.current++;
      const payload = JSON.stringify({ id, method, params });
      if (!clientIdRef.current) {
        reject(new Error('Bridge not connected'));
        return;
      }
      pendingRequestsRef.current.set(id, { resolve, reject });
      sendPayload(payload).catch((error) => {
        pendingRequestsRef.current.delete(id);
        reject(error);
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
      const result = await sendRpc('fs/readDirectory', { path });
      updateActiveSession((session) => ({
        ...session,
        label: shortWorkspaceLabel(path),
        workspace: path,
        fileTreeRoot: path,
        fileTreeEntries: normalizeFileEntries(result.entries),
        folderContents: {},
        expandedFolders: {},
      }));
    } catch (error) {
      appendSystemMessage(activeSessionIdRef.current, `Cannot read: ${path}`, 'error');
    }
  }

  async function updateThreadList(workspace = activeSession.workspace) {
    try {
      const result = await sendRpc('thread/list', { limit: 50, cwd: workspace });
      updateActiveSession((session) => ({ ...session, threadList: result.data || [] }));
    } catch (error) {
      appendSystemMessage(activeSessionIdRef.current, `Thread list error: ${error.message}`, 'error');
    }
  }

  async function toggleFolder(path) {
    const expanded = activeSession.expandedFolders[path];
    if (expanded) {
      updateActiveSession((session) => ({
        ...session,
        expandedFolders: { ...session.expandedFolders, [path]: false },
      }));
      return;
    }

    updateActiveSession((session) => ({
      ...session,
      expandedFolders: { ...session.expandedFolders, [path]: true },
    }));

    if (activeSession.folderContents[path]) return;

    try {
      const result = await sendRpc('fs/readDirectory', { path });
      updateActiveSession((session) => ({
        ...session,
        folderContents: { ...session.folderContents, [path]: normalizeFileEntries(result.entries) },
      }));
    } catch (error) {
      appendSystemMessage(activeSessionIdRef.current, `Error loading ${path}: ${error.message}`, 'error');
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
        label: thread.name || thread.preview?.slice(0, 28) || session.label,
        messages: [
          {
            id: makeId('system'),
            kind: 'system',
            tone: 'success',
            content: `Loaded: ${thread.name || thread.preview?.slice(0, 50) || threadId.slice(0, 8)}`,
          },
          ...flattenTurnItems(thread.turns || []),
        ],
      }));
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
    });
    updateActiveSession((current) => ({
      ...current,
      threadId: result.thread?.id || current.threadId,
      label: result.thread?.name || current.label,
    }));
    return result.thread?.id;
  }

  async function sendTurn() {
    const text = composerText.trim();
    if (!text || activeSession.isTurnActive) return;

    setComposerText('');
    appendChatMessage(activeSessionIdRef.current, 'user', text);
    updateActiveSession((session) => ({
      ...session,
      label: session.threadId ? session.label : text.slice(0, 28),
    }));

    let threadId = activeSession.threadId;
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
      }));
      appendSystemMessage(sessionId, 'Thread started', 'success');
      updateThreadList();
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
      setApprovalRequest({ requestId: data.id, params });
      return;
    }

    if (method === 'error') {
      appendSystemMessage(sessionId, `❌ ${params.error?.message || params.message || 'Unknown error'}`, 'error');
      notifyBrowser('Codex bridge error', params.error?.message || params.message || 'Unknown error');
    }
  }

  function respondApproval(allowed) {
    if (!approvalRequest || !clientIdRef.current) {
      setApprovalRequest(null);
      return;
    }

    sendPayload(JSON.stringify({
      id: approvalRequest.requestId,
      result: { decision: allowed ? 'accept' : 'decline' },
    })).catch((error) => {
      appendSystemMessage(activeSessionIdRef.current, `Approval response failed: ${error.message}`, 'error');
    });
    setApprovalRequest(null);
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
  const { quickCommand: cfQuickCommand, namedCommand: cfNamedCommand } = buildTunnelCommands(settings);
  return (
    <div className="bridge-root" onClickCapture={handleCopyClick}>
      <div id="header">
        <button id="sidebar-toggle" title="Toggle sidebar" onClick={() => setSidebarOpen((value) => !value)} type="button">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 12h18M3 6h18M3 18h18" />
          </svg>
        </button>
        
          <button 
            className="mobile-menu-btn" 
            style={{ display: 'none' }} 
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            ☰
          </button>
          <div className="logo">

          <span>⬡</span>
          Codex
        </div>
        <div className="status-shell">
          <div id="status-dot" className={connectionStatus} />
          <span id="status-text">
            {connectionStatus === 'connected'
              ? 'Connected'
              : connectionStatus === 'connecting'
                ? 'Connecting...'
                : 'Disconnected'}
          </span>
        </div>
        <div className="spacer" />
        <button className="header-action" onClick={() => setSettingsOpen(true)} type="button">
          Settings
        </button>
        <span id="workspace-chip" title={activeSession.workspace}>
          {activeSession.workspace}
        </span>
        {modelBadge ? <span id="model-badge">{modelBadge}</span> : null}
      </div>

      <div id="layout">
        
        <div 
          className={`mobile-overlay ${sidebarOpen ? 'active' : ''}`} 
          onClick={() => setSidebarOpen(false)}
        />
        <div id="sidebar" className={`${sidebarOpen ? 'open' : ''}`}>

          <div className="sidebar-section">
            <h3>Threads</h3>
            <div className="section-actions">
              <button
                id="btn-new-thread"
                onClick={async () => {
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
                }}
                type="button"
              >
                + New Thread
              </button>
              <button className="secondary" onClick={() => updateThreadList()} title="Refresh" type="button">
                ↻
              </button>
            </div>
            <input
              className="section-input"
              onChange={(event) => setThreadFilter(event.target.value)}
              placeholder="Filter threads..."
              type="text"
              value={threadFilter}
            />
          </div>

          <div id="thread-list">
            {filteredThreads.length === 0 ? (
              <div className="thread-empty">No threads yet</div>
            ) : (
              filteredThreads.map((thread) => (
                <div
                  key={thread.id}
                  className={`thread-item${thread.id === activeSession.threadId ? ' active' : ''}`}
                  onClick={() => loadThreadHistory(thread.id)}
                >
                  <div className="thread-title">{thread.preview?.slice(0, 40) || thread.name || 'unnamed'}</div>
                  <div className="thread-meta">
                    <span className="thread-status">
                      {thread.status?.type === 'idle' ? '💤' : thread.status?.type === 'running' ? '🔄' : '📌'}
                    </span>
                    <span>{formatDate(thread.updatedAt)}</span>
                  </div>
                </div>
              ))
            )}
          </div>

          <div id="workspace-section">
            <div className="sidebar-section">
              <h3>Workspace</h3>
              <div id="workspace-path" title="Click to browse" onClick={openWorkspaceBrowser}>
                {activeSession.workspace}
              </div>
              <div className="workspace-chip-list">
                {workspaceChoices.map((workspace) => (
                  <button
                    key={workspace}
                    className={`workspace-quick-chip${workspace === activeSession.workspace ? ' active' : ''}`}
                    onClick={() => switchWorkspace(workspace)}
                    type="button"
                  >
                    {shortWorkspaceLabel(workspace)}
                  </button>
                ))}
              </div>
              <div id="file-tree">
                <FileTree
                  entries={activeSession.fileTreeEntries}
                  rootPath={activeSession.fileTreeRoot}
                  folderContents={activeSession.folderContents}
                  expandedFolders={activeSession.expandedFolders}
                  onToggleFolder={toggleFolder}
                />
              </div>
            </div>
          </div>
        </div>

        <div id="chat-area">
          <div className="thread-tabs">
            <div className="thread-tab-list">
              {sessions.map((session) => (
                <div key={session.id} className={`thread-tab${session.id === activeSessionId ? ' active' : ''}`}>
                  <button
                    className="thread-tab-main"
                    onClick={() => setActiveSessionId(session.id)}
                    type="button"
                  >
                    <span className="thread-tab-title">{session.label || shortWorkspaceLabel(session.workspace)}</span>
                    <span className="thread-tab-meta">{shortWorkspaceLabel(session.workspace)}</span>
                  </button>
                  <button
                    className="thread-tab-close"
                    onClick={() => closeSession(session.id)}
                    type="button"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <button className="thread-tab-add" onClick={() => createNewSession()} type="button">
              + Thread
            </button>
          </div>
          <div id="toolbar">
            <select
              id="model-select"
              value={activeSession.model}
              onChange={(event) =>
                updateActiveSession((session) => ({ ...session, model: event.target.value }))
              }
            >
              {(modelOptions.length ? modelOptions : [{ name: 'gpt-5.4-codex', displayName: 'gpt-5.4-codex' }]).map((model) => (
                <option key={model.name || model.id} value={model.name || model.id}>
                  {model.displayName || model.name || model.id}
                </option>
              ))}
            </select>
            <select
              id="sandbox-select"
              value={activeSession.sandbox}
              onChange={(event) =>
                updateActiveSession((session) => ({ ...session, sandbox: event.target.value }))
              }
            >
              <option value="workspace-write">workspace-write</option>
              <option value="read-only">read-only</option>
              <option value="danger-full-access">danger-full-access</option>
            </select>
            <select
              id="approval-select"
              value={activeSession.approvalPolicy}
              onChange={(event) =>
                updateActiveSession((session) => ({ ...session, approvalPolicy: event.target.value }))
              }
            >
              <option value="on-request">on-request</option>
              <option value="untrusted">untrusted</option>
              <option value="never">never</option>
            </select>
            <div className="spacer" />
            <button
              className={`debug-toggle${debugOpen ? ' active' : ''}`}
              onClick={() => setDebugOpen((value) => !value)}
              type="button"
            >
              {debugOpen ? 'Hide Debug' : 'Show Debug'}
            </button>
            <button
              className="debug-clear"
              onClick={() => setDebugEvents([])}
              type="button"
            >
              Clear Logs
            </button>
            <span id="turn-indicator" className={activeSession.turnState}>
              {activeSession.turnState === 'running'
                ? 'Running'
                : activeSession.turnState === 'done'
                  ? 'Done'
                  : activeSession.turnState === 'error'
                    ? 'Error'
                    : 'Idle'}
            </span>
          </div>

          <div id="messages">
            <div className="session-overview">
              <div className="overview-card">
                <span className="overview-label">Workspace</span>
                <strong>{shortWorkspaceLabel(activeSession.workspace)}</strong>
                <span className="overview-meta">{activeSession.workspace}</span>
              </div>
              <div className="overview-card">
                <span className="overview-label">Thread</span>
                <strong>{activeThread?.name || activeThread?.preview?.slice(0, 44) || 'Fresh thread'}</strong>
                <span className="overview-meta">{activeSession.threadList.length} threads available</span>
              </div>
              <div className="overview-card compact">
                <span className="overview-label">Runtime</span>
                <strong>{connectionStatus === 'connected' ? 'Ready' : connectionStatus === 'connecting' ? 'Booting' : 'Offline'}</strong>
                <span className="overview-meta">{activeSession.sandbox} / {activeSession.approvalPolicy}</span>
              </div>
            </div>
            <div className={`debug-panel${debugOpen ? ' open' : ''}`}>
              <button
                className="debug-panel-header"
                onClick={() => setDebugOpen((value) => !value)}
                type="button"
              >
                <strong>Lifecycle Debug</strong>
                <span>
                  status={connectionStatus} transportGen={transportGenerationRef.current} client={clientIdRef.current || 'none'}
                </span>
                <span className={`debug-chevron${debugOpen ? ' open' : ''}`}>▶</span>
              </button>
              {debugOpen ? (
                <div className="debug-panel-body">
                  {debugEvents.length === 0 ? (
                    <div className="debug-line muted">No events yet</div>
                  ) : (
                    debugEvents.map((line, index) => (
                      <div className="debug-line" key={`${line}-${index}`}>
                        {line}
                      </div>
                    ))
                  )}
                </div>
              ) : (
                <div className="debug-panel-preview">
                  Hidden by default. Open when you need connection lifecycle details.
                </div>
              )}
            </div>
            {activeSession.messages.length === 0 ? (
              <div id="welcome">
                <div className="welcome-hero">
                  <div className="welcome-eyebrow">Next.js control room</div>
                  <div className="logo-large">⬡</div>
                  <h2>Ready for session-based Codex workspaces</h2>
                  <p>
                    The UI is now mounted through Next.js so we can keep growing toward multi-tab,
                    multi-workspace, split-pane threads without keeping everything trapped in one
                    HTML file.
                  </p>
                  <div className="hero-grid">
                    <div className="hero-card">
                      <strong>Thread tabs</strong>
                      <span>Top tabs now map to the conversations you actually work in.</span>
                    </div>
                    <div className="hero-card">
                      <strong>Bridge-backed</strong>
                      <span>The same Codex RPC websocket flow still powers threads, workspace, and approvals.</span>
                    </div>
                    <div className="hero-card">
                      <strong>Next-driven</strong>
                      <span>We can now add tabs, split layouts, and richer routing without rewriting from scratch.</span>
                    </div>
                  </div>
                  <div className="prompt-suggestions">
                    <div className="quick-select-title">Quick workspace jumps</div>
                    {workspaceChoices.map((workspace) => (
                      <button
                        key={workspace}
                        className={`prompt-chip${workspace === activeSession.workspace ? ' active-chip' : ''}`}
                        onClick={() => switchWorkspace(workspace)}
                        type="button"
                      >
                        {shortWorkspaceLabel(workspace)}
                      </button>
                    ))}
                  </div>
                  <div className="prompt-suggestions">
                    {PROMPT_SUGGESTIONS.map((prompt) => (
                      <button
                        key={prompt}
                        className="prompt-chip"
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
                </div>
                <div className="shortcuts">
                  <div>
                    <div className="shortcuts-title">Fast controls</div>
                    <div className="shortcut"><kbd>Enter</kbd><span>Send message</span></div>
                    <div className="shortcut"><kbd>Shift + Enter</kbd><span>New line</span></div>
                    <div className="shortcut"><kbd>Ctrl/Cmd + L</kbd><span>Clear chat</span></div>
                  </div>
                  <div className="shortcut-note">
                    Tip: model, sandbox, approval, thread list, and workspace path all still feed into
                    Codex. We are just controlling them from a real app shell now.
                  </div>
                </div>
              </div>
            ) : (
              activeSession.messages.map((message) => (
                <MessageItem key={message.id} message={message} onToggleReasoning={toggleReasoning} />
              ))
            )}
            <div ref={messagesEndRef} />
          </div>

          <div id="input-area">
            <div id="composer-shell">
              <div id="composer-meta">
                <span className="meta-pill">Thread composer</span>
                <span>Enter to send, Shift+Enter for a new line</span>
              </div>
              <textarea
                id="prompt-input"
                ref={composerRef}
                placeholder="Ask Codex anything..."
                rows={1}
                value={composerText}
                onChange={handleComposerChange}
                onKeyDown={handleComposerKeyDown}
              />
            </div>
            <button id="btn-send" disabled={connectionStatus !== 'connected' || activeSession.isTurnActive} onClick={sendTurn} type="button">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 2L11 13" />
                <path d="M22 2L15 22L11 13L2 9L22 2Z" />
              </svg>
              Send
            </button>
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

      {settingsOpen ? (
        <div id="settings-modal" className="show">
          <div id="settings-box">
            <h3>Settings</h3>
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
                Config path and tunnel id are reserved for a later managed launch flow.
              </div>
            </div>

            <div className="actions">
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
                      className={`prompt-chip${active ? ' active-chip' : ''}`}
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
