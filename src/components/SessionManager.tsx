import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Key,
  ShieldCheck,
  AlertTriangle,
  Upload,
  RefreshCw,
  Trash2,
  FileJson,
  User,
  Clock,
  Radio,
  Lock,
  PlusCircle,
  ToggleLeft,
  ToggleRight,
  ExternalLink,
  Power,
  Layers,
  Database,
  Search,
  Filter,
  ChevronDown,
  ChevronUp,
  Activity,
  Terminal,
  Cpu,
  Zap,
  MessageSquare,
  AlertOctagon,
  Server,
  Sliders,
  BarChart2,
  Globe,
  Hash,
  CheckCircle2,
  Save,
  Download
} from 'lucide-react';
import { SafeAccountMeta } from '../adapters/messenger/AccountConnection';
import { IsolatedAccountLogConsole } from './IsolatedAccountLogConsole';
import { IsolatedAccountMetrics } from '../services/AccountRuntimeLogManager';

interface SessionManagerProps {
  token?: string;
}

interface AccountsApiResponse {
  accounts: SafeAccountMeta[];
  cloudSyncStats?: {
    runningAccountsCount: number;
    offlineAccountsCount: number;
    failedAccountsCount: number;
    connectingAccountsCount: number;
    totalAccountsCount: number;
    totalMessagesToday: number;
    totalAiMessages: number;
  };
  limits: {
    maxAuthorizedAccounts: number;
    maxCookieSessions: number;
    currentAuthorizedCount: number;
    currentCookieCount: number;
  };
}

export type SessionTab =
  | 'Overview'
  | 'Runtime Logs'
  | 'Authentication'
  | 'MQTT'
  | 'Messenger Events'
  | 'Commands'
  | 'AI Engine'
  | 'Errors'
  | 'Performance'
  | 'Network';

export const SessionManager: React.FC<SessionManagerProps> = ({ token }) => {
  const [accounts, setAccounts] = useState<SafeAccountMeta[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [activeTab, setActiveTab] = useState<SessionTab>('Overview');
  const [metrics, setMetrics] = useState<IsolatedAccountMetrics | null>(null);

  // Account Switcher Filters & Dropdown State
  const [switcherOpen, setSwitcherOpen] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ONLINE' | 'OFFLINE'>('ALL');
  const [providerFilter, setProviderFilter] = useState<string>('ALL');
  const [sortBy, setSortBy] = useState<'UPTIME_DESC' | 'NEWEST' | 'NAME'>('UPTIME_DESC');

  // Form & System state
  const [cookieJsonInput, setCookieJsonInput] = useState<string>('');
  const [oauthTokenInput, setOauthTokenInput] = useState<string>('');
  const [oauthUidInput, setOauthUidInput] = useState<string>('');
  const [oauthNameInput, setOauthNameInput] = useState<string>('');
  const [activeAddTab, setActiveAddTab] = useState<'cookie' | 'oauth'>('cookie');
  const [validationResult, setValidationResult] = useState<{ valid: boolean; userId?: string; cookiesCount?: number; error?: string } | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Manage Session Modal States
  const [isManageSessionOpen, setIsManageSessionOpen] = useState<boolean>(false);
  const [manageSessionCookieInput, setManageSessionCookieInput] = useState<string>('');
  const [manageSessionValidation, setManageSessionValidation] = useState<{ valid: boolean; userId?: string; cookiesCount?: number; error?: string } | null>(null);
  const [isUpdatingSession, setIsUpdatingSession] = useState<boolean>(false);

  // Live Action Execution Console & Button Loading States
  const [activeActionId, setActiveActionId] = useState<string | null>(null);
  const [actionTerminalLogs, setActionTerminalLogs] = useState<{ id: string; timestamp: string; level: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR'; text: string }[]>([]);
  const [showActionTerminal, setShowActionTerminal] = useState<boolean>(false);

  const appendActionLog = useCallback((text: string, level: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR' = 'INFO') => {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
    setActionTerminalLogs((prev) => [
      ...prev,
      { id: `action_log_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`, timestamp: time, level, text }
    ]);
  }, []);

  const runActionWithLiveConsole = async (
    actionKey: string,
    actionTitle: string,
    accountId: string,
    apiEndpoint: string,
    httpMethod: string = 'POST',
    bodyPayload?: any
  ) => {
    if (activeActionId) return;
    setActiveActionId(actionKey);
    setShowActionTerminal(true);

    appendActionLog(`🚀 [${actionTitle}] initiated for account ${accountId}`, 'INFO');
    appendActionLog(`📡 Dispatching API request (${httpMethod} ${apiEndpoint})...`, 'INFO');

    try {
      const res = await fetch(apiEndpoint, {
        method: httpMethod,
        headers: getHeaders(),
        body: bodyPayload ? JSON.stringify(bodyPayload) : undefined
      });

      const data = await res.json().catch(() => ({}));

      if (res.ok && data.success !== false) {
        appendActionLog(`✅ [${actionTitle}] completed successfully on backend!`, 'SUCCESS');
        if (data.message) {
          appendActionLog(`📝 Server details: ${data.message}`, 'SUCCESS');
        }
        setMessage({ type: 'success', text: data.message || `${actionTitle} completed for account [${accountId}]` });
      } else {
        const errMsg = data.error || data.message || `HTTP ${res.status}`;
        appendActionLog(`❌ [${actionTitle}] failed: ${errMsg}`, 'ERROR');
        setMessage({ type: 'error', text: `${actionTitle} failed: ${errMsg}` });
      }
    } catch (err: any) {
      appendActionLog(`❌ Network error during [${actionTitle}]: ${err.message}`, 'ERROR');
      setMessage({ type: 'error', text: err.message });
    } finally {
      appendActionLog(`⚙️ Re-fetching account connection states and live metrics...`, 'INFO');
      await fetchAccounts();
      appendActionLog(`✨ Live state update finished. Session is up to date.`, 'SUCCESS');
      setActiveActionId(null);
    }
  };

  useEffect(() => {
    if (!manageSessionCookieInput.trim()) {
      setManageSessionValidation(null);
      return;
    }
    try {
      const parsed = JSON.parse(manageSessionCookieInput);
      if (!Array.isArray(parsed)) {
        setManageSessionValidation({ valid: false, error: 'Cookie JSON must be an array of cookie objects.' });
        return;
      }
      let foundUserId = '';
      let hasXs = false;
      for (const item of parsed) {
        if (item.key === 'c_user' || item.name === 'c_user' || item.key === 'i_user' || item.name === 'i_user') {
          foundUserId = String(item.value);
        }
        if (item.key === 'xs' || item.name === 'xs') {
          hasXs = true;
        }
      }
      if (!foundUserId) {
        setManageSessionValidation({ valid: false, error: 'Could not find "c_user" cookie in JSON array.' });
      } else if (!hasXs) {
        setManageSessionValidation({ valid: false, error: 'Could not find "xs" session cookie in JSON array. Re-export the AppState.' });
      } else {
        setManageSessionValidation({ valid: true, userId: foundUserId, cookiesCount: parsed.length });
      }
    } catch (e: any) {
      setManageSessionValidation({ valid: false, error: `Invalid JSON format: ${e.message}` });
    }
  }, [manageSessionCookieInput]);

  const handleReplaceCookie = async () => {
    if (!selectedAccount) return;
    if (!manageSessionValidation?.valid) return;

    await runActionWithLiveConsole(
      'replace_cookie',
      'Replace Cookie & Reconnect',
      selectedAccount.accountId,
      '/api/messenger/accounts/cookie/update',
      'POST',
      {
        accountId: selectedAccount.accountId,
        slotId: selectedAccount.slotId,
        cookieJson: manageSessionCookieInput,
        botName: selectedAccount.displayName
      }
    );
    setIsManageSessionOpen(false);
    setManageSessionCookieInput('');
  };

  // Add Bot Wizard States
  const [wizardStep, setWizardStep] = useState<number>(1);
  const [botNameInput, setBotNameInput] = useState<string>('');
  const connectionMode = 'default' as const;


  const [cloudSyncStats, setCloudSyncStats] = useState<{
    runningAccountsCount: number;
    offlineAccountsCount: number;
    failedAccountsCount: number;
    connectingAccountsCount: number;
    totalAccountsCount: number;
    totalMessagesToday: number;
    totalAiMessages: number;
  }>({
    runningAccountsCount: 0,
    offlineAccountsCount: 0,
    failedAccountsCount: 0,
    connectingAccountsCount: 0,
    totalAccountsCount: 0,
    totalMessagesToday: 0,
    totalAiMessages: 0
  });

  const [limits, setLimits] = useState({
    maxAuthorizedAccounts: 10,
    maxCookieSessions: 10,
    currentAuthorizedCount: 0,
    currentCookieCount: 0
  });

  const getHeaders = useCallback(() => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
  }, [token]);

  const fetchAccounts = useCallback(async () => {
    try {
      const res = await fetch('/api/messenger/accounts', { headers: getHeaders() });
      const contentType = res.headers.get('content-type');
      if (res.ok && contentType && contentType.includes('application/json')) {
        const data: AccountsApiResponse = await res.json();
        setAccounts(data.accounts || []);
        if (data.cloudSyncStats) setCloudSyncStats(data.cloudSyncStats);
        if (data.limits) setLimits(data.limits);

        // Filter ONLY LOCAL_ADMIN and ADMIN_DASHBOARD accounts
        const localAccounts = (data.accounts || []).filter(
          (a) => !a.creationSource || a.creationSource === 'LOCAL_ADMIN' || a.creationSource === 'ADMIN_DASHBOARD'
        );

        // Auto select first LOCAL_ADMIN account if none selected
        if (localAccounts.length > 0) {
          setSelectedAccountId((prev) => {
            if (prev && localAccounts.some((a) => a.accountId === prev)) return prev;
            return localAccounts[0].accountId;
          });
        }
      }
    } catch (err) {
      console.error('Failed to fetch accounts:', err);
    }
  }, [getHeaders]);

  useEffect(() => {
    fetchAccounts();

    // Establish secure real-time EventSource connection for sub-second live updates
    let sse: EventSource | null = null;
    if (token) {
      try {
        const url = `/api/messenger/accounts/live-status?token=${encodeURIComponent(token)}`;
        sse = new EventSource(url);
        sse.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data && data.success) {
              setAccounts(data.accounts || []);
              if (data.cloudSyncStats) setCloudSyncStats(data.cloudSyncStats);
              if (data.limits) setLimits(data.limits);

              const localAccounts = (data.accounts || []).filter(
                (a) => !a.creationSource || a.creationSource === 'LOCAL_ADMIN' || a.creationSource === 'ADMIN_DASHBOARD'
              );
              if (localAccounts.length > 0) {
                setSelectedAccountId((prev) => {
                  if (prev && localAccounts.some((a) => a.accountId === prev)) return prev;
                  return localAccounts[0].accountId;
                });
              }
            }
          } catch (e) {
            console.error('Error parsing real-time live-status data:', e);
          }
        };
        sse.onerror = () => {
          if (sse) sse.close();
        };
      } catch (err) {
        console.error('Failed to establish real-time live-status SSE connection:', err);
      }
    }

    // Passive backup polling every 15 seconds
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        fetchAccounts();
      }
    }, 15000);

    return () => {
      clearInterval(interval);
      if (sse) sse.close();
    };
  }, [fetchAccounts, token]);

  // Session Manager ONLY shows accounts where creationSource === 'LOCAL_ADMIN' or 'ADMIN_DASHBOARD' (or legacy undefined).
  // Cloud Synchronized accounts ('CLOUD_SYNC' / source === 'client') are strictly filtered out of Session Manager UI!
  const localAdminAccounts = useMemo(() => {
    return accounts.filter((acc) => {
      const isClient = acc.creationSource === 'CLIENT_SYNC' || (acc as any).source === 'client';
      return !isClient && (!acc.creationSource || acc.creationSource === 'LOCAL_ADMIN' || acc.creationSource === 'ADMIN_DASHBOARD');
    });
  }, [accounts]);

  // Selected Account Metadata
  const selectedAccount = useMemo(() => {
    return localAdminAccounts.find((a) => a.accountId === selectedAccountId) || localAdminAccounts[0] || null;
  }, [localAdminAccounts, selectedAccountId]);

  // Unique Provider List for Switcher Filter
  const availableProviders = useMemo(() => {
    const set = new Set<string>();
    localAdminAccounts.forEach((a) => {
      if (a.activeProviderName || a.provider) set.add(a.activeProviderName || a.provider);
    });
    return Array.from(set);
  }, [localAdminAccounts]);

  // Filtered & Sorted LOCAL_ADMIN accounts in Switcher
  const filteredSwitcherAccounts = useMemo(() => {
    return localAdminAccounts
      .filter((acc) => {
        // Search query
        if (searchQuery.trim() !== '') {
          const q = searchQuery.toLowerCase();
          const nameMatch = (acc.displayName || '').toLowerCase().includes(q);
          const uidMatch = (acc.rawUid || acc.uid || '').toLowerCase().includes(q);
          const idMatch = acc.accountId.toLowerCase().includes(q);
          if (!nameMatch && !uidMatch && !idMatch) return false;
        }
        // Online / Offline filter
        if (statusFilter === 'ONLINE') {
          const isOnline = acc.status === 'CONNECTED' || acc.status === 'MQTT_LISTENING' || acc.status === 'ONLINE';
          if (!isOnline) return false;
        } else if (statusFilter === 'OFFLINE') {
          const isOnline = acc.status === 'CONNECTED' || acc.status === 'MQTT_LISTENING' || acc.status === 'ONLINE';
          if (isOnline) return false;
        }
        // Provider filter
        if (providerFilter !== 'ALL') {
          const p = acc.activeProviderName || acc.provider;
          if (p !== providerFilter) return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (sortBy === 'NAME') {
          return (a.displayName || '').localeCompare(b.displayName || '');
        }
        if (sortBy === 'NEWEST') {
          const aTime = a.connectedAt ? new Date(a.connectedAt).getTime() : 0;
          const bTime = b.connectedAt ? new Date(b.connectedAt).getTime() : 0;
          return bTime - aTime;
        }
        // Default UPTIME_DESC
        return (b.sessionDurationMs || 0) - (a.sessionDurationMs || 0);
      });
  }, [localAdminAccounts, searchQuery, statusFilter, providerFilter, sortBy]);

  // Cookie Validation
  useEffect(() => {
    if (!cookieJsonInput.trim()) {
      setValidationResult(null);
      return;
    }
    try {
      const parsed = JSON.parse(cookieJsonInput);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const cUserCookie = parsed.find((c: any) => c.key === 'c_user' || c.name === 'c_user' || c.key === 'i_user' || c.name === 'i_user');
        const xsCookie = parsed.find((c: any) => c.key === 'xs' || c.name === 'xs');
        if (!cUserCookie) {
          setValidationResult({
            valid: false,
            error: "Missing required 'c_user' (or 'i_user') cookie key. Export the AppState again from a logged-in facebook.com tab."
          });
        } else if (!xsCookie) {
          setValidationResult({
            valid: false,
            error: "Missing required 'xs' session cookie. The export is incomplete — re-export the AppState from a logged-in facebook.com tab."
          });
        } else {
          setValidationResult({
            valid: true,
            userId: String(cUserCookie.value),
            cookiesCount: parsed.length
          });
        }
      } else {
        setValidationResult({ valid: false, error: 'JSON must be a non-empty array of cookie objects.' });
      }
    } catch (err: any) {
      setValidationResult({ valid: false, error: err.message });
    }
  }, [cookieJsonInput]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      setCookieJsonInput(event.target?.result as string || '');
    };
    reader.readAsText(file);
  };

  const handleAddCookieAccount = async () => {
    if (!validationResult?.valid) {
      setMessage({ type: 'error', text: 'Please complete Step 2 and provide a valid cookie array first.' });
      return;
    }

    setLoading(true);
    setMessage(null);

    try {
      const res = await fetch('/api/messenger/accounts/cookie', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          cookieJson: cookieJsonInput,
          botName: botNameInput.trim() || undefined,
          connectionMode
        })
      });

      const data = await res.json();

      if (!res.ok || data.error) {
        setMessage({ type: 'error', text: data.error || 'Failed to add cookie account.' });
      } else {
        setMessage({ type: 'success', text: `Messenger bot [${data.accountMeta?.displayName || botNameInput || 'ShiPu Bot'}] created successfully in PENDING status. Auto-synchronization is now active!` });
        // Reset inputs & step
        setCookieJsonInput('');
        setBotNameInput('');
        setValidationResult(null);
        setWizardStep(1);
        fetchAccounts();
        if (data.accountMeta?.accountId) {
          setSelectedAccountId(data.accountMeta.accountId);
        }
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Failed to add cookie account.' });
    } finally {
      setLoading(false);
    }
  };

  const handleAddOAuthAccount = async () => {
    if (!oauthTokenInput.trim() || !oauthUidInput.trim()) {
      setMessage({ type: 'error', text: 'Meta OAuth Access Token and User/Page UID are required.' });
      return;
    }

    setLoading(true);
    setMessage(null);

    try {
      const res = await fetch('/api/messenger/accounts/oauth', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          accessToken: oauthTokenInput,
          uid: oauthUidInput,
          name: oauthNameInput
        })
      });

      const data = await res.json();

      if (!res.ok || data.error) {
        setMessage({ type: 'error', text: data.error || 'Failed to add Meta OAuth account.' });
      } else {
        setMessage({ type: 'success', text: `Meta Authorized Account connected successfully!` });
        setOauthTokenInput('');
        setOauthUidInput('');
        setOauthNameInput('');
        fetchAccounts();
        if (data.accountMeta?.accountId) {
          setSelectedAccountId(data.accountMeta.accountId);
        }
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Failed to add OAuth account.' });
    } finally {
      setLoading(false);
    }
  };

  const handleReconnect = async (accountId: string) => {
    await runActionWithLiveConsole('reconnect', 'Reconnect Account', accountId, `/api/messenger/accounts/${accountId}/reconnect`);
  };

  const handleRestart = async (accountId: string) => {
    await runActionWithLiveConsole('restart', 'Restart Engine', accountId, `/api/messenger/accounts/${accountId}/restart`);
  };

  const handleRecover = async (accountId: string) => {
    await runActionWithLiveConsole('recover', 'Supervisor Recovery', accountId, `/api/messenger/accounts/${accountId}/recover`);
  };

  const handleReload = async (accountId: string) => {
    await runActionWithLiveConsole('reload', 'Hot Reload', accountId, `/api/messenger/accounts/${accountId}/reload`);
  };

  const handleManualBackup = async (accountId: string) => {
    await runActionWithLiveConsole('backup', 'cPanel Backup', accountId, `/api/messenger/accounts/${accountId}/backup-now`);
  };

  const handleManualRestore = async (accountId: string) => {
    await runActionWithLiveConsole('restore', 'cPanel Restore', accountId, `/api/messenger/accounts/${accountId}/restore-session`);
  };

  const handleDisconnect = async (accountId: string) => {
    await runActionWithLiveConsole('disconnect', 'Disconnect Account', accountId, `/api/messenger/accounts/${accountId}/disconnect`);
  };

  const handleToggleBot = async (accountId: string, currentStatus: boolean) => {
    await runActionWithLiveConsole(
      'toggle',
      `Toggle Bot (${currentStatus ? 'Disable' : 'Enable'})`,
      accountId,
      `/api/messenger/accounts/${accountId}/toggle-bot`,
      'POST',
      { enabled: !currentStatus }
    );
  };

  const handleRemoveAccount = async (accountId: string) => {
    await runActionWithLiveConsole(
      'remove_account',
      'Remove Account',
      accountId,
      `/api/messenger/accounts/${accountId}`,
      'DELETE'
    );
  };

  const formatDuration = (ms: number = 0) => {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'CONNECTED':
      case 'MQTT_LISTENING':
      case 'ONLINE':
        return (
          <span className="px-2.5 py-1 text-xs font-semibold rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5" /> ACTIVE ONLINE
          </span>
        );
      case 'TEMPORARY_ERROR':
        return (
          <span className="px-2.5 py-1 text-xs font-semibold rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5" /> RETRYING
          </span>
        );
      case 'REAUTH_REQUIRED':
      case 'AUTH_EXPIRED':
      case 'CHECKPOINT':
        return (
          <span className="px-2.5 py-1 text-xs font-semibold rounded-full bg-rose-500/20 text-rose-400 border border-rose-500/30 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5" /> RE-AUTH REQUIRED
          </span>
        );
      default:
        return (
          <span className="px-2.5 py-1 text-xs font-semibold rounded-full bg-slate-800 text-slate-300 border border-slate-700 flex items-center gap-1.5">
            <Power className="w-3.5 h-3.5" /> {status}
          </span>
        );
    }
  };

  const tabsList: { id: SessionTab; label: string; icon: React.ReactNode }[] = [
    { id: 'Overview', label: 'Overview', icon: <Layers className="w-3.5 h-3.5" /> },
    { id: 'Runtime Logs', label: 'Runtime Logs', icon: <Terminal className="w-3.5 h-3.5" /> },
    { id: 'Authentication', label: 'Authentication', icon: <Lock className="w-3.5 h-3.5" /> },
    { id: 'MQTT', label: 'MQTT Stream', icon: <Radio className="w-3.5 h-3.5" /> },
    { id: 'Messenger Events', label: 'Events', icon: <MessageSquare className="w-3.5 h-3.5" /> },
    { id: 'Commands', label: 'Commands', icon: <Hash className="w-3.5 h-3.5" /> },
    { id: 'AI Engine', label: 'AI Brain', icon: <Zap className="w-3.5 h-3.5" /> },
    { id: 'Errors', label: 'Errors', icon: <AlertOctagon className="w-3.5 h-3.5" /> },
    { id: 'Performance', label: 'Performance', icon: <Cpu className="w-3.5 h-3.5" /> },
    { id: 'Network', label: 'Network', icon: <Globe className="w-3.5 h-3.5" /> }
  ];

  return (
    <div className="space-y-6">
      {/* Top Banner & Multi-Account Switcher Header */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800/80 pb-4">
          <div>
            <div className="flex items-center gap-2">
              <Sliders className="w-6 h-6 text-indigo-400" />
              <h2 className="text-xl font-bold text-white tracking-tight">Bot Admin Messenger Session Manager</h2>
              <span className="px-2.5 py-0.5 text-[11px] font-bold rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 uppercase">
                LOCAL ADMIN ISOLATED
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Monitors and manages Messenger accounts added directly from Bot Admin. Cloud Synchronized accounts run isolated in background.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <div className="bg-slate-950 border border-slate-800 rounded-lg px-3.5 py-2 text-center">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">Cookie Sessions</div>
              <div className="text-sm font-bold text-indigo-400">
                {limits.currentCookieCount} / {limits.maxCookieSessions}
              </div>
            </div>
            <div className="bg-slate-950 border border-slate-800 rounded-lg px-3.5 py-2 text-center">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">Meta Authorized</div>
              <div className="text-sm font-bold text-emerald-400">
                {limits.currentAuthorizedCount} / {limits.maxAuthorizedAccounts}
              </div>
            </div>
          </div>
        </div>

        {/* ACCOUNT SWITCHER DROPDOWN & FILTER BAR */}
        <div className="relative">
          <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-950 p-3 rounded-xl border border-slate-800">
            <div className="flex items-center gap-2 flex-1 min-w-[280px]">
              <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Account:</span>
              <button
                onClick={() => setSwitcherOpen(!switcherOpen)}
                className="flex items-center justify-between gap-3 bg-slate-900 hover:bg-slate-850 border border-slate-700/80 rounded-lg px-3.5 py-2 text-left text-sm text-white font-semibold transition w-full md:w-auto min-w-[300px] shadow-sm"
              >
                {selectedAccount ? (
                  <div className="flex items-center gap-2.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
                    <div>
                      <span className="text-white font-bold">{selectedAccount.displayName}</span>
                      <span className="text-xs text-indigo-300 font-mono ml-2">({selectedAccount.rawUid || selectedAccount.uid})</span>
                    </div>
                  </div>
                ) : (
                  <span className="text-slate-400">No Local Admin Account Selected</span>
                )}
                {switcherOpen ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
              </button>
            </div>

            <div className="flex items-center gap-2 text-xs">
              <span className="text-slate-500">Total Local Accounts:</span>
              <span className="text-indigo-400 font-bold bg-indigo-950/60 border border-indigo-500/30 px-2 py-0.5 rounded">
                {localAdminAccounts.length}
              </span>
            </div>
          </div>

          {/* SWITCHER DROPDOWN PANEL */}
          {switcherOpen && (
            <div className="absolute left-0 right-0 top-full mt-2 z-50 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
                <div className="relative flex-1 min-w-[200px]">
                  <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search by Messenger Name or UID..."
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-9 pr-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
                  />
                </div>

                <div className="flex items-center gap-2 flex-wrap text-xs">
                  {/* Status filter */}
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value as any)}
                    className="bg-slate-950 border border-slate-800 text-slate-300 rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-indigo-500"
                  >
                    <option value="ALL">All Statuses</option>
                    <option value="ONLINE">Online Only</option>
                    <option value="OFFLINE">Offline Only</option>
                  </select>

                  {/* Provider filter */}
                  <select
                    value={providerFilter}
                    onChange={(e) => setProviderFilter(e.target.value)}
                    className="bg-slate-950 border border-slate-800 text-slate-300 rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-indigo-500"
                  >
                    <option value="ALL">All Providers</option>
                    {availableProviders.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>

                  {/* Sort order */}
                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as any)}
                    className="bg-slate-950 border border-slate-800 text-slate-300 rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-indigo-500"
                  >
                    <option value="UPTIME_DESC">Sort: Longest Runtime</option>
                    <option value="NEWEST">Sort: Newest First</option>
                    <option value="NAME">Sort: By Name</option>
                  </select>
                </div>
              </div>

              {/* Account selection list */}
              <div className="max-h-[280px] overflow-y-auto space-y-1.5">
                {filteredSwitcherAccounts.length === 0 ? (
                  <div className="py-6 text-center text-slate-500 text-xs">No local admin Messenger accounts matched your search.</div>
                ) : (
                  filteredSwitcherAccounts.map((acc) => {
                    const isSelected = acc.accountId === selectedAccountId;
                    return (
                      <div
                        key={acc.accountId}
                        onClick={() => {
                          setSelectedAccountId(acc.accountId);
                          setSwitcherOpen(false);
                        }}
                        className={`p-3 rounded-lg border transition cursor-pointer flex items-center justify-between gap-3 ${
                          isSelected
                            ? 'bg-indigo-950/60 border-indigo-500 text-white shadow-md'
                            : 'bg-slate-950/80 border-slate-800 hover:border-slate-700 text-slate-300'
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <div className={`w-2 h-2 rounded-full ${acc.status === 'CONNECTED' || acc.status === 'MQTT_LISTENING' ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                          <div>
                            <div className="font-bold text-sm text-white flex items-center gap-2">
                              {acc.displayName}
                              <span className="text-[10px] bg-slate-800 text-indigo-300 px-1.5 py-0.2 rounded font-mono uppercase">
                                {acc.authType}
                              </span>
                            </div>
                            <div className="text-xs text-slate-400 mt-0.5 flex items-center gap-2">
                              <span>UID: <code className="text-indigo-300 font-mono">{acc.rawUid || acc.uid}</code></span>
                              <span>•</span>
                              <span>Provider: {acc.activeProviderName || acc.provider}</span>
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-3">
                          {getStatusBadge(acc.status)}
                          {isSelected && <CheckCircle2 className="w-5 h-5 text-indigo-400" />}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {message && (
        <div
          className={`p-4 rounded-xl text-sm border flex items-center gap-3 ${
            message.type === 'success'
              ? 'bg-emerald-950/40 border-emerald-500/30 text-emerald-300'
              : 'bg-rose-950/40 border-rose-500/30 text-rose-300'
          }`}
        >
          {message.type === 'success' ? <ShieldCheck className="w-5 h-5 shrink-0" /> : <AlertTriangle className="w-5 h-5 shrink-0" />}
          <span>{message.text}</span>
        </div>
      )}

      {/* METRICS HEADER CARD FOR SELECTED LOCAL_ADMIN ACCOUNT */}
      {selectedAccount && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-xl space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
            <div>
              <div className="text-xl font-bold text-white flex items-center gap-3">
                {selectedAccount.displayName}
                <span className="text-xs bg-indigo-950/80 text-indigo-300 border border-indigo-500/30 px-2.5 py-0.5 rounded-full font-semibold uppercase">
                  {selectedAccount.creationSource || 'LOCAL_ADMIN'}
                </span>
              </div>
              <div className="text-xs text-slate-400 mt-1 flex items-center gap-3">
                <span>UID: <code className="bg-slate-950 px-1.5 py-0.5 rounded text-indigo-300 font-mono">{selectedAccount.rawUid || selectedAccount.uid}</code></span>
                <span>•</span>
                <span>Provider: <strong className="text-slate-200">{selectedAccount.activeProviderName || selectedAccount.provider}</strong></span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {getStatusBadge(selectedAccount.status)}
              <span className="px-2.5 py-1 text-xs font-semibold rounded-full bg-slate-950 text-indigo-300 border border-slate-800 uppercase">
                MQTT: {selectedAccount.mqttStatus}
              </span>
            </div>
          </div>

          {/* 13 METRICS GRID FOR SELECTED ACCOUNT */}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7 gap-3">
            <div className="bg-slate-950/80 border border-slate-800/80 p-3 rounded-lg text-center">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">1. Messenger Name</div>
              <div className="text-xs font-bold text-white truncate mt-1">{selectedAccount.displayName}</div>
            </div>

            <div className="bg-slate-950/80 border border-slate-800/80 p-3 rounded-lg text-center">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">2. Messenger UID</div>
              <div className="text-xs font-bold text-indigo-300 font-mono truncate mt-1">{selectedAccount.rawUid || selectedAccount.uid}</div>
            </div>

            <div className="bg-slate-950/80 border border-slate-800/80 p-3 rounded-lg text-center">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">3. Provider</div>
              <div className="text-xs font-bold text-slate-200 truncate mt-1">{selectedAccount.activeProviderName || selectedAccount.provider}</div>
            </div>

            <div className="bg-slate-950/80 border border-slate-800/80 p-3 rounded-lg text-center" id="session-login-status-card">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">4. Login Status</div>
              <div className={`text-xs font-bold mt-1 ${
                (selectedAccount.loginStatus || 'LOGGED_IN') === 'LOGGED_IN'
                  ? 'text-emerald-400'
                  : (selectedAccount.loginStatus || 'LOGGED_IN') === 'PENDING'
                  ? 'text-amber-400 animate-pulse'
                  : 'text-rose-400 font-bold'
              }`}>
                {selectedAccount.loginStatus || 'LOGGED_IN'}
              </div>
            </div>

            <div className="bg-slate-950/80 border border-slate-800/80 p-3 rounded-lg text-center">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">5. MQTT Status</div>
              <div className="text-xs font-bold text-cyan-400 mt-1 uppercase">{selectedAccount.mqttStatus}</div>
            </div>

            <div className="bg-slate-950/80 border border-slate-800/80 p-3 rounded-lg text-center">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">6. Runtime Uptime</div>
              <div className="text-xs font-bold text-amber-400 mt-1">{formatDuration(selectedAccount.sessionDurationMs || 0)}</div>
            </div>

            <div className="bg-slate-950/80 border border-slate-800/80 p-3 rounded-lg text-center">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">7. Last Heartbeat</div>
              <div className="text-xs font-bold text-slate-300 mt-1">
                {selectedAccount.lastHeartbeat ? new Date(selectedAccount.lastHeartbeat).toLocaleTimeString() : 'Active'}
              </div>
            </div>

            <div className="bg-slate-950/80 border border-slate-800/80 p-3 rounded-lg text-center">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">8. Thread Count</div>
              <div className="text-xs font-bold text-indigo-400 mt-1">{metrics?.currentThreadCount || 1}</div>
            </div>

            <div className="bg-slate-950/80 border border-slate-800/80 p-3 rounded-lg text-center">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">9. Message Count</div>
              <div className="text-xs font-bold text-emerald-400 mt-1">
                {selectedAccount.stats?.messagesToday || 0} / {selectedAccount.stats?.totalMessages || 0}
              </div>
            </div>

            <div className="bg-slate-950/80 border border-slate-800/80 p-3 rounded-lg text-center">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">10. Error Count</div>
              <div className="text-xs font-bold text-rose-400 mt-1">{metrics?.errorCount || 0}</div>
            </div>

            <div className="bg-slate-950/80 border border-slate-800/80 p-3 rounded-lg text-center">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">11. Warning Count</div>
              <div className="text-xs font-bold text-amber-400 mt-1">{metrics?.warningCount || 0}</div>
            </div>

            <div className="bg-slate-950/80 border border-slate-800/80 p-3 rounded-lg text-center">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">12. AI Requests</div>
              <div className="text-xs font-bold text-purple-400 mt-1">{selectedAccount.stats?.aiMessages || 0}</div>
            </div>

            <div className="col-span-2 sm:col-span-1 bg-slate-950/80 border border-slate-800/80 p-3 rounded-lg text-center">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">13. Session Duration</div>
              <div className="text-xs font-bold text-cyan-300 mt-1">{formatDuration(selectedAccount.sessionDurationMs || 0)}</div>
            </div>

            <div className="bg-slate-950/80 border border-slate-800/80 p-3 rounded-lg text-center">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">14. MongoDB Sync</div>
              <div className={`text-xs font-bold mt-1 ${
                selectedAccount.mongoBackupStatus === 'FAILED'
                  ? 'text-rose-400'
                  : selectedAccount.mongoBackupStatus === 'NOT_SAVED'
                  ? 'text-amber-400'
                  : 'text-emerald-400'
              }`}>
                {selectedAccount.mongoBackupStatus || 'HEALTHY'}
              </div>
            </div>

            <div className="bg-slate-950/80 border border-slate-800/80 p-3 rounded-lg text-center">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">15. cPanel FTP</div>
              <div className={`text-xs font-bold mt-1 ${
                selectedAccount.ftpBackupStatus === 'FAILED'
                  ? 'text-rose-400'
                  : selectedAccount.ftpBackupStatus === 'NOT_SAVED'
                  ? 'text-amber-400'
                  : 'text-emerald-400'
              }`}>
                {selectedAccount.ftpBackupStatus || 'NOT_SAVED'}
              </div>
            </div>

            <div className="bg-slate-950/80 border border-slate-800/80 p-3 rounded-lg text-center">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">16. Persistence</div>
              <div className={`text-xs font-bold mt-1 ${
                selectedAccount.persistentSession === 'NOT_SAVED'
                  ? 'text-amber-400'
                  : 'text-emerald-400'
              }`}>
                {selectedAccount.persistentSession || 'SAVED'}
              </div>
            </div>

            <div className="bg-slate-950/80 border border-slate-800/80 p-3 rounded-lg text-center">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">17. Restore Status</div>
              <div className={`text-xs font-bold mt-1 ${
                selectedAccount.restoreStatus === 'FAILED'
                  ? 'text-rose-400'
                  : selectedAccount.restoreStatus === 'RESTORED'
                  ? 'text-emerald-400'
                  : 'text-slate-400'
              }`}>
                {selectedAccount.restoreStatus || 'NONE'}
              </div>
            </div>
          </div>

          {/* Quick Action Controls for Selected Account */}
          <div className="flex flex-wrap items-center justify-between pt-3 border-t border-slate-800 gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => setIsManageSessionOpen(true)}
                disabled={!!activeActionId}
                className="px-4 py-2 text-xs text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg transition font-bold flex items-center gap-2 shadow"
              >
                <Key className="w-4 h-4" /> Manage Session / Update Cookie
              </button>
              <button
                onClick={() => handleToggleBot(selectedAccount.accountId, selectedAccount.botEnabled)}
                disabled={!!activeActionId}
                className={`text-xs px-3.5 py-2 rounded-lg border font-semibold flex items-center gap-2 transition disabled:opacity-50 ${
                  selectedAccount.botEnabled
                    ? 'bg-emerald-950/40 border-emerald-500/30 text-emerald-300 hover:bg-emerald-900/40'
                    : 'bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700'
                }`}
              >
                {activeActionId === 'toggle' ? (
                  <RefreshCw className="w-4 h-4 animate-spin text-indigo-400" />
                ) : selectedAccount.botEnabled ? (
                  <ToggleRight className="w-4 h-4 text-emerald-400" />
                ) : (
                  <ToggleLeft className="w-4 h-4" />
                )}
                Bot Status: {activeActionId === 'toggle' ? 'UPDATING...' : selectedAccount.botEnabled ? 'ENABLED' : 'DISABLED'}
              </button>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => handleReconnect(selectedAccount.accountId)}
                disabled={!!activeActionId}
                className="px-3 py-1.5 text-xs text-emerald-300 bg-emerald-950/60 hover:bg-emerald-900/60 disabled:opacity-50 border border-emerald-500/30 rounded-lg transition font-medium flex items-center gap-1.5"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${activeActionId === 'reconnect' ? 'animate-spin text-emerald-400' : ''}`} />
                {activeActionId === 'reconnect' ? 'Reconnecting...' : 'Reconnect'}
              </button>
              <button
                onClick={() => handleRestart(selectedAccount.accountId)}
                disabled={!!activeActionId}
                className="px-3 py-1.5 text-xs text-indigo-300 bg-indigo-950/60 hover:bg-indigo-900/60 disabled:opacity-50 border border-indigo-500/30 rounded-lg transition font-medium flex items-center gap-1.5"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${activeActionId === 'restart' ? 'animate-spin text-indigo-400' : ''}`} />
                {activeActionId === 'restart' ? 'Restarting...' : 'Restart Engine'}
              </button>
              <button
                onClick={() => handleRecover(selectedAccount.accountId)}
                disabled={!!activeActionId}
                className="px-3 py-1.5 text-xs text-amber-300 bg-amber-950/60 hover:bg-amber-900/60 disabled:opacity-50 border border-amber-500/30 rounded-lg transition font-medium flex items-center gap-1.5"
              >
                <ShieldCheck className={`w-3.5 h-3.5 ${activeActionId === 'recover' ? 'animate-bounce text-amber-400' : ''}`} />
                {activeActionId === 'recover' ? 'Recovering...' : 'Run Supervisor Recovery'}
              </button>
              <button
                onClick={() => handleReload(selectedAccount.accountId)}
                disabled={!!activeActionId}
                className="px-3 py-1.5 text-xs text-cyan-300 bg-cyan-950/60 hover:bg-cyan-900/60 disabled:opacity-50 border border-cyan-500/30 rounded-lg transition font-medium flex items-center gap-1.5"
              >
                <Zap className={`w-3.5 h-3.5 ${activeActionId === 'reload' ? 'animate-bounce text-cyan-400' : ''}`} />
                {activeActionId === 'reload' ? 'Reloading...' : 'Hot Reload'}
              </button>
              <button
                onClick={() => handleManualBackup(selectedAccount.accountId)}
                disabled={!!activeActionId}
                className="px-3 py-1.5 text-xs text-emerald-300 bg-emerald-950/60 hover:bg-emerald-900/60 disabled:opacity-50 border border-emerald-500/30 rounded-lg transition font-medium flex items-center gap-1.5"
                title="Manually save/overwrite backup session to cPanel FTP storage"
              >
                <Save className={`w-3.5 h-3.5 ${activeActionId === 'backup' ? 'animate-spin text-emerald-400' : ''}`} />
                {activeActionId === 'backup' ? 'Backing up...' : 'cPanel Backup'}
              </button>
              <button
                onClick={() => handleManualRestore(selectedAccount.accountId)}
                disabled={!!activeActionId}
                className="px-3 py-1.5 text-xs text-teal-300 bg-teal-950/60 hover:bg-teal-900/60 disabled:opacity-50 border border-teal-500/30 rounded-lg transition font-medium flex items-center gap-1.5"
                title="Force-restore from backup session stored in cPanel FTP"
              >
                <Download className={`w-3.5 h-3.5 ${activeActionId === 'restore' ? 'animate-bounce text-teal-400' : ''}`} />
                {activeActionId === 'restore' ? 'Restoring...' : 'cPanel Restore'}
              </button>
              <button
                onClick={() => handleDisconnect(selectedAccount.accountId)}
                disabled={!!activeActionId}
                className="px-3 py-1.5 text-xs text-slate-300 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 border border-slate-700 rounded-lg transition font-medium flex items-center gap-1.5"
              >
                <Power className={`w-3.5 h-3.5 ${activeActionId === 'disconnect' ? 'animate-spin text-rose-400' : ''}`} />
                {activeActionId === 'disconnect' ? 'Disconnecting...' : 'Disconnect'}
              </button>
              <button
                onClick={() => handleRemoveAccount(selectedAccount.accountId)}
                disabled={!!activeActionId}
                className="p-2 text-slate-400 hover:text-rose-400 disabled:opacity-50 bg-slate-800 hover:bg-slate-700 rounded-lg transition"
                title="Remove Account"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* ANIMATED LIVE ACTION EXECUTION TERMINAL */}
          {showActionTerminal && (
            <div className="mt-4 bg-slate-950 border border-slate-800/90 rounded-xl p-4 space-y-3 font-mono text-xs shadow-xl animate-fadeIn">
              <div className="flex items-center justify-between border-b border-slate-800/80 pb-2.5">
                <div className="flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-emerald-400 animate-pulse" />
                  <span className="font-bold text-slate-200 tracking-wide">LIVE ACTION EXECUTION TERMINAL</span>
                  {activeActionId ? (
                    <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 animate-pulse flex items-center gap-1">
                      <RefreshCw className="w-2.5 h-2.5 animate-spin" /> RUNNING
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-slate-800 text-slate-400 border border-slate-700">
                      IDLE
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setActiveTab('Runtime Logs')}
                    className="px-2.5 py-1 text-[11px] font-semibold text-indigo-300 bg-indigo-950/60 hover:bg-indigo-900/60 border border-indigo-500/30 rounded-md transition flex items-center gap-1"
                  >
                    <Terminal className="w-3 h-3" /> Switch to Full Runtime Logs
                  </button>
                  <button
                    onClick={() => setActionTerminalLogs([])}
                    className="p-1 text-slate-400 hover:text-white bg-slate-900 rounded-md transition border border-slate-800"
                    title="Clear Terminal Log"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => setShowActionTerminal(false)}
                    className="text-slate-400 hover:text-white text-xs px-2 py-0.5 bg-slate-900 rounded-md transition border border-slate-800"
                  >
                    ✕
                  </button>
                </div>
              </div>

              <div className="max-h-52 overflow-y-auto space-y-1.5 scrollbar-thin scrollbar-thumb-slate-800 p-1 font-mono text-[11px]">
                {actionTerminalLogs.length === 0 ? (
                  <div className="text-slate-600 italic">Console initialized. Click any control button above to execute action and view live progress...</div>
                ) : (
                  actionTerminalLogs.map((log) => (
                    <div key={log.id} className="flex items-start gap-2 leading-relaxed">
                      <span className="text-slate-500 shrink-0 font-normal">[{log.timestamp}]</span>
                      <span
                        className={
                          log.level === 'SUCCESS'
                            ? 'text-emerald-400 font-semibold'
                            : log.level === 'ERROR'
                            ? 'text-rose-400 font-semibold'
                            : log.level === 'WARN'
                            ? 'text-amber-400 font-semibold'
                            : 'text-cyan-300'
                        }
                      >
                        {log.text}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* SESSION EXPIRED / AUTH FAILED PROMINENT WARNING BANNER */}
      {selectedAccount && (['SESSION EXPIRED', 'AUTH_EXPIRED', 'REAUTH_REQUIRED', 'AUTHENTICATION FAILED', 'FAILED', 'TEMPORARY_ERROR'].includes(selectedAccount.status)) && (
        <div className="bg-rose-950/60 border border-rose-500/40 rounded-xl p-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-6 h-6 text-rose-400 shrink-0" />
            <div>
              <div className="text-sm font-bold text-white">Authentication Required / Session Expired</div>
              <div className="text-xs text-rose-300 mt-0.5">The Messenger session for {selectedAccount.displayName} has expired or failed authentication. Click below to replace your cookie Appstate JSON and reconnect without recreating the bot.</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleReconnect(selectedAccount.accountId)}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-lg transition shadow flex items-center gap-2 whitespace-nowrap"
            >
              <RefreshCw className="w-4 h-4" /> Reconnect
            </button>
            <button
              onClick={() => setIsManageSessionOpen(true)}
              className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold rounded-lg transition shadow flex items-center gap-2 whitespace-nowrap"
            >
              <Key className="w-4 h-4" /> Update Cookie / Replace Session
            </button>
          </div>
        </div>
      )}

      {/* MANAGE SESSION / REPLACE COOKIE MODAL */}
      {isManageSessionOpen && selectedAccount && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-xl p-6 shadow-2xl space-y-5 animate-scaleIn">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
              <div className="flex items-center gap-2.5">
                <Key className="w-5 h-5 text-indigo-400" />
                <h3 className="text-base font-bold text-white">Manage Session — {selectedAccount.displayName}</h3>
              </div>
              <button
                onClick={() => setIsManageSessionOpen(false)}
                className="text-slate-400 hover:text-white text-sm font-bold px-2 py-1 bg-slate-800 hover:bg-slate-700 rounded-lg transition"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4 text-xs text-slate-300">
              <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 space-y-1.5">
                <div className="text-slate-400 font-semibold uppercase tracking-wider text-[10px]">Session Account Details</div>
                <div className="flex justify-between"><span>Account ID:</span> <code className="text-indigo-300 font-mono">{selectedAccount.accountId}</code></div>
                <div className="flex justify-between"><span>Messenger UID:</span> <code className="text-indigo-300 font-mono">{selectedAccount.rawUid || selectedAccount.uid}</code></div>
                <div className="flex justify-between"><span>Login Status:</span> <span className="font-bold text-emerald-400">{selectedAccount.loginStatus || 'LOGGED_IN'}</span></div>
                <div className="flex justify-between"><span>MQTT Status:</span> <span className="font-bold text-cyan-400 uppercase">{selectedAccount.mqttStatus}</span></div>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-bold text-slate-200 block">Replace Cookie Appstate JSON</label>
                <p className="text-[11px] text-slate-400">Paste your new Facebook FCA Appstate JSON array below. The bot ID, metadata, and configurations will be preserved while updating credentials.</p>
                <textarea
                  value={manageSessionCookieInput}
                  onChange={(e) => setManageSessionCookieInput(e.target.value)}
                  placeholder="[{'key': 'sb', 'value': '...'}, {'key': 'c_user', 'value': '...'}]"
                  rows={5}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 font-mono text-xs text-slate-200 focus:outline-none focus:border-indigo-500 transition"
                />

                {manageSessionValidation && (
                  <div className={`p-3 rounded-lg border text-xs ${manageSessionValidation.valid ? 'bg-emerald-950/40 border-emerald-500/30 text-emerald-300' : 'bg-rose-950/40 border-rose-500/30 text-rose-300'}`}>
                    {manageSessionValidation.valid
                      ? `✓ Valid Appstate JSON (${manageSessionValidation.cookiesCount} keys, UID: ${manageSessionValidation.userId})`
                      : `✕ Error: ${manageSessionValidation.error}`}
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-800">
              <button
                onClick={() => setIsManageSessionOpen(false)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold rounded-xl transition"
              >
                Cancel
              </button>
              <button
                onClick={handleReplaceCookie}
                disabled={!manageSessionValidation?.valid || activeActionId === 'replace_cookie'}
                className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-bold rounded-xl transition shadow flex items-center gap-2"
              >
                {activeActionId === 'replace_cookie' ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                {activeActionId === 'replace_cookie' ? 'Updating & Reconnecting...' : 'Replace Cookie & Reconnect'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* DEDICATED TABS BAR FOR SELECTED ACCOUNT */}
      {selectedAccount && (
        <div className="space-y-4">
          <div className="flex items-center gap-1 overflow-x-auto bg-slate-900 p-1.5 rounded-xl border border-slate-800 scrollbar-none">
            {tabsList.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-3.5 py-2 rounded-lg text-xs font-semibold whitespace-nowrap transition flex items-center gap-2 ${
                  activeTab === tab.id
                    ? 'bg-indigo-600 text-white shadow-md'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>

          {/* TAB CONTENT AREAS */}
          {activeTab === 'Overview' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
                <h4 className="text-sm font-bold text-white flex items-center gap-2 border-b border-slate-800 pb-2">
                  <Database className="w-4 h-4 text-indigo-400" /> Account Identity & Configuration
                </h4>
                <div className="space-y-2 text-xs text-slate-300">
                  <div className="flex justify-between py-1 border-b border-slate-800/60">
                    <span className="text-slate-500">Account ID:</span>
                    <code className="text-indigo-300 font-mono">{selectedAccount.accountId}</code>
                  </div>
                  <div className="flex justify-between py-1 border-b border-slate-800/60">
                    <span className="text-slate-500">Messenger UID:</span>
                    <code className="text-indigo-300 font-mono">{selectedAccount.rawUid || selectedAccount.uid}</code>
                  </div>
                  <div className="flex justify-between py-1 border-b border-slate-800/60">
                    <span className="text-slate-500">Display Name:</span>
                    <span className="font-semibold text-white">{selectedAccount.displayName}</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-slate-800/60">
                    <span className="text-slate-500">Auth Method:</span>
                    <span className="uppercase text-slate-200 font-medium">{selectedAccount.authType}</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-slate-800/60">
                    <span className="text-slate-500">Source Tag:</span>
                    <span className="px-2 py-0.5 bg-indigo-950 text-indigo-300 border border-indigo-500/30 rounded text-[10px] font-bold">
                      {selectedAccount.creationSource || 'LOCAL_ADMIN'}
                    </span>
                  </div>
                  <div className="flex justify-between py-1">
                    <span className="text-slate-500">Connected Since:</span>
                    <span className="text-slate-300">{selectedAccount.connectedAt ? new Date(selectedAccount.connectedAt).toLocaleString() : '—'}</span>
                  </div>
                </div>
              </div>

              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
                <h4 className="text-sm font-bold text-white flex items-center gap-2 border-b border-slate-800 pb-2">
                  <Activity className="w-4 h-4 text-emerald-400" /> Message Stats & Rate Limits
                </h4>
                <div className="space-y-2 text-xs text-slate-300">
                  <div className="flex justify-between py-1 border-b border-slate-800/60">
                    <span className="text-slate-500">Messages Today:</span>
                    <span className="font-bold text-emerald-400">{selectedAccount.stats?.messagesToday || 0}</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-slate-800/60">
                    <span className="text-slate-500">Total Lifetime Messages:</span>
                    <span className="font-bold text-slate-200">{selectedAccount.stats?.totalMessages || 0}</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-slate-800/60">
                    <span className="text-slate-500">AI Intelligent Responses:</span>
                    <span className="font-bold text-purple-400">{selectedAccount.stats?.aiMessages || 0}</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-slate-800/60">
                    <span className="text-slate-500">Reconnections Triggered:</span>
                    <span className="font-bold text-amber-400">{selectedAccount.reconnectCount || 0}</span>
                  </div>
                  <div className="flex justify-between py-1">
                    <span className="text-slate-500">Last Incoming Activity:</span>
                    <span className="text-slate-300">
                      {selectedAccount.lastIncomingMessageAt ? new Date(selectedAccount.lastIncomingMessageAt).toLocaleTimeString() : 'No messages yet'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* RUNTIME LOGS TAB & CATEGORY LOG TABS */}
          {activeTab !== 'Overview' && (
            <IsolatedAccountLogConsole
              accountId={selectedAccount.accountId}
              accountName={selectedAccount.displayName}
              activeCategoryTab={activeTab}
              token={token}
              onMetricsUpdate={(m) => setMetrics(m)}
            />
          )}
        </div>
      )}

      {/* Add New Messenger Account Form */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg space-y-4">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <h3 className="text-base font-semibold text-slate-200 flex items-center gap-2">
            <PlusCircle className="w-4 h-4 text-indigo-400" /> Add New Messenger Account (Local Admin)
          </h3>

          <div className="flex items-center bg-slate-950 p-1 rounded-lg border border-slate-800 text-xs">
            <button
              onClick={() => setActiveAddTab('cookie')}
              className={`px-3 py-1 rounded-md font-medium transition ${
                activeAddTab === 'cookie' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Cookie Appstate JSON
            </button>
            <button
              onClick={() => setActiveAddTab('oauth')}
              className={`px-3 py-1 rounded-md font-medium transition ${
                activeAddTab === 'oauth' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Meta Official OAuth
            </button>
          </div>
        </div>

        {activeAddTab === 'cookie' ? (
          <div className="space-y-5 bg-slate-950/40 p-5 rounded-xl border border-slate-800/60">
            {/* Step Indicators */}
            <div className="flex items-center justify-between pb-2 border-b border-slate-800/50">
              <span className="text-xs font-bold uppercase tracking-wider text-indigo-400">Add Bot Wizard</span>
              <div className="flex items-center gap-1.5">
                {[1, 2, 3].map((step) => (
                  <div
                    key={step}
                    onClick={() => {
                      if (step < wizardStep || (step === 2 && validationResult?.valid)) {
                        setWizardStep(step);
                      }
                    }}
                    className={`h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-bold cursor-pointer transition-all duration-300 ${
                      step === wizardStep
                        ? 'bg-indigo-600 text-white ring-2 ring-indigo-500/30'
                        : step < wizardStep
                        ? 'bg-emerald-600 text-white'
                        : 'bg-slate-800 text-slate-400'
                    }`}
                  >
                    {step < wizardStep ? '✓' : step}
                  </div>
                ))}
              </div>
            </div>

            {/* Wizard Steps */}
            {wizardStep === 1 && (
              <div className="space-y-4">
                <div>
                  <h4 className="text-xs font-bold text-slate-200 mb-1">Step 1: Bot Identity</h4>
                  <p className="text-[11px] text-slate-400 mb-3">Define a personalized name for this Messenger bot. This helps you organize and monitor multiple bots within the workspace.</p>
                  
                  <label className="text-[11px] font-semibold text-slate-400 block mb-1">Bot Name</label>
                  <input
                    type="text"
                    value={botNameInput}
                    onChange={(e) => setBotNameInput(e.target.value)}
                    placeholder="e.g. Jarvis AI Bot, Customer Assistant"
                    className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 transition"
                  />
                </div>

                <div className="pt-2">
                  <button
                    onClick={() => setWizardStep(2)}
                    disabled={!botNameInput.trim()}
                    className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold rounded-lg transition shadow flex items-center justify-center gap-2"
                  >
                    Continue to Cookie Setup
                  </button>
                </div>
              </div>
            )}

            {wizardStep === 2 && (
              <div className="space-y-4">
                <div>
                  <h4 className="text-xs font-bold text-slate-200 mb-1">Step 2: Messenger Session Authentication</h4>
                  <p className="text-[11px] text-slate-400 mb-3">Paste your Facebook FCA Appstate cookie array or upload a cookie JSON file. This credentials file enables your bot to receive messages.</p>
                  
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-[11px] font-semibold text-slate-400">Cookie Appstate JSON</label>
                    <label className="text-xs text-indigo-400 hover:text-indigo-300 cursor-pointer flex items-center gap-1 font-medium bg-slate-900/60 px-2 py-0.5 rounded border border-slate-800">
                      <Upload className="w-3 h-3" /> Upload .json
                      <input type="file" accept=".json" onChange={handleFileUpload} className="hidden" />
                    </label>
                  </div>

                  <textarea
                    value={cookieJsonInput}
                    onChange={(e) => setCookieJsonInput(e.target.value)}
                    placeholder="[{'key': 'sb', 'value': '...'}, {'key': 'c_user', 'value': '...'}]"
                    rows={4}
                    className="w-full bg-slate-900 border border-slate-800 rounded-lg p-3 text-xs font-mono text-slate-300 focus:outline-none focus:border-indigo-500 transition"
                  />
                </div>

                {validationResult && (
                  <div
                    className={`text-xs p-3 rounded-lg border transition ${
                      validationResult.valid ? 'bg-emerald-950/30 border-emerald-500/30 text-emerald-300' : 'bg-rose-950/30 border-rose-500/30 text-rose-300'
                    }`}
                  >
                    {validationResult.valid
                      ? `✓ Valid Cookie Array (${validationResult.cookiesCount} keys found, UID: ${validationResult.userId})`
                      : `✕ Validation Error: ${validationResult.error}`}
                  </div>
                )}

                <div className="flex items-center gap-3 pt-2">
                  <button
                    onClick={() => setWizardStep(1)}
                    className="flex-1 py-2 bg-slate-900 hover:bg-slate-800 text-slate-300 text-xs font-semibold rounded-lg border border-slate-800 transition"
                  >
                    Back
                  </button>
                  <button
                    onClick={() => setWizardStep(3)}
                    disabled={!validationResult?.valid}
                    className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold rounded-lg transition shadow"
                  >
                    Configure Database
                  </button>
                </div>
              </div>
            )}

            {wizardStep === 3 && (
              <div className="space-y-4">
                <div>
                  <h4 className="text-xs font-bold text-slate-200 mb-1">Step 3: Database Storage</h4>
                  <p className="text-[11px] text-slate-400 mb-4">This bot stores its memories, user data, and brain knowledge in the shared Firebase Realtime Database (shipu-messsenger-bot).</p>

                  <div className="p-3.5 rounded-xl border border-indigo-500 bg-indigo-600/10 flex flex-col items-center justify-center text-center">
                    <Database className="w-5 h-5 mb-1.5 text-indigo-400" />
                    <span className="text-xs font-bold text-slate-200 block">Firebase Shared DB</span>
                    <span className="text-[10px] text-slate-400 mt-1">Automatic setup — nothing to configure</span>
                  </div>
                </div>

                <div className="flex items-center gap-3 pt-2">
                  <button
                    onClick={() => setWizardStep(2)}
                    className="flex-1 py-2.5 bg-slate-900 hover:bg-slate-800 text-slate-300 text-xs font-semibold rounded-lg border border-slate-800 transition"
                  >
                    Back
                  </button>
                  <button
                    onClick={handleAddCookieAccount}
                    disabled={loading}
                    className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-45 disabled:cursor-not-allowed text-white text-xs font-semibold rounded-lg transition shadow flex items-center justify-center gap-1.5"
                  >
                    {loading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Lock className="w-3.5 h-3.5" />}
                    Create & Boot Bot
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">Page / User UID</label>
                <input
                  type="text"
                  value={oauthUidInput}
                  onChange={(e) => setOauthUidInput(e.target.value)}
                  placeholder="e.g. 100082341234123"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">Display Name (Optional)</label>
                <input
                  type="text"
                  value={oauthNameInput}
                  onChange={(e) => setOauthNameInput(e.target.value)}
                  placeholder="e.g. Official Page Account"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                />
              </div>
            </div>

            <div>
              <label className="text-xs font-semibold text-slate-300 block mb-1">Meta Access Token</label>
              <input
                type="password"
                value={oauthTokenInput}
                onChange={(e) => setOauthTokenInput(e.target.value)}
                placeholder="EAA..."
                className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-xs font-mono text-slate-200 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <button
              onClick={handleAddOAuthAccount}
              disabled={loading}
              className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-semibold rounded-lg transition shadow flex items-center justify-center gap-2"
            >
              {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
              Validate & Connect Meta Authorized Account (LOCAL_ADMIN)
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
