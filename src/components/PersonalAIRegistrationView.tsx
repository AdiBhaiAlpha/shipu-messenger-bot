import React, { useState, useEffect } from 'react';
import { 
  Bot, Plus, Trash2, RefreshCw, Power, Settings, Terminal, Shield, 
  Activity, Clock, Cpu, Users, MessageSquare, CheckCircle2, AlertTriangle, 
  XCircle, Lock, Key, Sliders, ChevronRight, FileText, Upload, Copy, Check, Eye
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface PersonalAIModel {
  accountId: string;
  uid: string;
  displayName: string;
  authType: 'cookie' | 'oauth';
  provider: string;
  status: string;
  mqttStatus: string;
  enabled: boolean;
  autoReplyEnabled: boolean;
  typingIndicatorEnabled: boolean;
  readReceiptsEnabled: boolean;
  replyDelayMs: number;
  maxHistory: number;
  aiModel: string;
  memorySize: number;
  autoSleepMode: boolean;
  ignoreUnknownUsers: boolean;
  ignoreGroupChats: boolean;
  allowOnlyPrivateInbox: boolean;
  businessHoursEnabled: boolean;
  businessHoursStart: string;
  businessHoursEnd: string;
  blacklistUids: string[];
  whitelistUids: string[];
  totalConversations: number;
  messagesReceivedToday: number;
  messagesRepliedToday: number;
  avgResponseTimeMs: number;
  contextMemoryUsage: number;
  lastIncomingMessageTime: number;
  lastOutgoingReplyTime: number;
  sessionUptime: number;
  reconnectCount: number;
  errorCount: number;
  aiRequestCount: number;
  currentQueueLength: number;
  connectedAt?: string;
  lastValidatedAt?: string;
  lastErrorCode?: string;
  activeProviderName: string;
  liveConsoleLogs: Array<{ id: string; timestamp: number; type: string; message: string }>;
}

interface PersonalAIRegistrationViewProps {
  token?: string;
}

export const PersonalAIRegistrationView: React.FC<PersonalAIRegistrationViewProps> = ({ token }) => {
  const [accounts, setAccounts] = useState<PersonalAIModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedAccount, setSelectedAccount] = useState<PersonalAIModel | null>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'console' | 'settings'>('overview');
  const [showAddModal, setShowAddModal] = useState(false);
  const [cookieJsonInput, setCookieJsonInput] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Settings form state for selected account
  const [settingsForm, setSettingsForm] = useState<Partial<PersonalAIModel>>({});

  const getHeaders = () => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
  };

  const fetchAccounts = async () => {
    try {
      const res = await fetch('/api/personal-ai/accounts');
      const data = await res.json();
      if (data.accounts) {
        setAccounts(data.accounts);
        if (selectedAccount) {
          const updated = data.accounts.find((a: PersonalAIModel) => a.accountId === selectedAccount.accountId);
          if (updated) {
            setSelectedAccount(updated);
          }
        } else if (data.accounts.length > 0) {
          setSelectedAccount(data.accounts[0]);
          setSettingsForm(data.accounts[0]);
        }
      }
    } catch (e) {
      console.error('Failed to fetch Personal AI accounts:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAccounts();
    const interval = setInterval(fetchAccounts, 30000);
    return () => clearInterval(interval);
  }, [selectedAccount?.accountId]);

  useEffect(() => {
    if (selectedAccount) {
      setSettingsForm(selectedAccount);
    }
  }, [selectedAccount?.accountId]);

  const handleRegisterCookie = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cookieJsonInput.trim()) {
      setErrorMsg('Please paste your AppState cookie JSON.');
      return;
    }

    setIsRegistering(true);
    setErrorMsg('');
    setSuccessMsg('');

    try {
      const res = await fetch('/api/personal-ai/accounts/cookie', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ cookieJson: cookieJsonInput })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to register account.');
      }

      setSuccessMsg('Personal AI Assistant successfully registered and connected!');
      setCookieJsonInput('');
      setShowAddModal(false);
      await fetchAccounts();
      if (data.accountMeta) {
        setSelectedAccount(data.accountMeta);
      }
    } catch (err: any) {
      setErrorMsg(err.message);
    } finally {
      setIsRegistering(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const content = event.target?.result as string;
        setCookieJsonInput(content);
      } catch (err) {
        setErrorMsg('Failed to read uploaded file.');
      }
    };
    reader.readAsText(file);
  };

  const handleReconnect = async (accountId: string) => {
    try {
      await fetch(`/api/personal-ai/accounts/${accountId}/reconnect`, {
        method: 'POST',
        headers: getHeaders()
      });
      await fetchAccounts();
    } catch (e) {
      console.error('Failed to reconnect:', e);
    }
  };

  const handleDisconnect = async (accountId: string) => {
    try {
      await fetch(`/api/personal-ai/accounts/${accountId}/disconnect`, {
        method: 'POST',
        headers: getHeaders()
      });
      await fetchAccounts();
    } catch (e) {
      console.error('Failed to disconnect:', e);
    }
  };

  const handleDelete = async (accountId: string) => {
    if (!confirm('Are you sure you want to remove this Personal AI Assistant account?')) return;
    try {
      await fetch(`/api/personal-ai/accounts/${accountId}`, {
        method: 'DELETE',
        headers: getHeaders()
      });
      setSelectedAccount(null);
      await fetchAccounts();
    } catch (e) {
      console.error('Failed to delete:', e);
    }
  };

  const handleToggle = async (accountId: string, currentEnabled: boolean) => {
    try {
      await fetch(`/api/personal-ai/accounts/${accountId}/toggle`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ enabled: !currentEnabled })
      });
      await fetchAccounts();
    } catch (e) {
      console.error('Failed to toggle:', e);
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAccount) return;

    try {
      const res = await fetch(`/api/personal-ai/accounts/${selectedAccount.accountId}/settings`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify(settingsForm)
      });
      if (res.ok) {
        setSuccessMsg('Settings updated successfully.');
        setTimeout(() => setSuccessMsg(''), 3000);
        await fetchAccounts();
      }
    } catch (e) {
      setErrorMsg('Failed to save settings.');
    }
  };

  const handleClearLogs = async (accountId: string) => {
    try {
      await fetch(`/api/personal-ai/accounts/${accountId}/logs`, {
        method: 'DELETE',
        headers: getHeaders()
      });
      await fetchAccounts();
    } catch (e) {
      console.error('Failed to clear logs:', e);
    }
  };

  const formatTimestamp = (ts: number) => {
    if (!ts) return 'Never';
    return new Date(ts).toLocaleTimeString();
  };

  return (
    <div className="space-y-6 pb-12">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 rounded-2xl shadow-sm">
        <div>
          <div className="flex items-center gap-3">
            <div className="p-3 bg-violet-50 dark:bg-violet-950/50 text-violet-600 dark:text-violet-400 rounded-xl">
              <Bot className="w-7 h-7" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Personal AI Registration</h1>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Register Facebook accounts as dedicated ShiPu AI personal assistants with isolated MQTT listeners & smart context routing.
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => { setShowAddModal(true); setErrorMsg(''); }}
            className="flex items-center gap-2 px-5 py-2.5 bg-violet-600 hover:bg-violet-700 text-white font-medium rounded-xl shadow-sm transition-all"
          >
            <Plus className="w-5 h-5" />
            Register Personal AI
          </button>
        </div>
      </div>

      {successMsg && (
        <div className="p-4 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 rounded-xl flex items-center gap-3">
          <CheckCircle2 className="w-5 h-5 flex-shrink-0" />
          <span>{successMsg}</span>
        </div>
      )}

      {errorMsg && (
        <div className="p-4 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300 rounded-xl flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 flex-shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* Main Grid: Account Selector Sidebar + Detailed Control Panel */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Account List Sidebar */}
        <div className="lg:col-span-4 space-y-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3 px-2">
              Registered Assistants ({accounts.length})
            </h2>

            {loading ? (
              <div className="py-12 text-center text-slate-400">Loading assistants...</div>
            ) : accounts.length === 0 ? (
              <div className="text-center py-10 px-4">
                <Bot className="w-12 h-12 text-slate-300 dark:text-slate-700 mx-auto mb-3" />
                <p className="text-slate-600 dark:text-slate-400 font-medium text-sm">No Personal AI accounts registered yet.</p>
                <p className="text-slate-400 text-xs mt-1">Click "Register Personal AI" to add your first Facebook AppState cookie.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {accounts.map((acc) => {
                  const isSelected = selectedAccount?.accountId === acc.accountId;
                  const isOnline = acc.status === 'CONNECTED' || acc.status === 'MQTT_LISTENING';
                  return (
                    <button
                      key={acc.accountId}
                      onClick={() => { setSelectedAccount(acc); setSettingsForm(acc); }}
                      className={`w-full text-left p-3.5 rounded-xl transition-all border flex items-center justify-between ${
                        isSelected 
                          ? 'bg-violet-50/80 dark:bg-violet-950/40 border-violet-300 dark:border-violet-700 shadow-xs' 
                          : 'bg-slate-50/50 dark:bg-slate-800/50 border-slate-200/60 dark:border-slate-700/60 hover:bg-slate-100 dark:hover:bg-slate-800'
                      }`}
                    >
                      <div className="flex items-center gap-3 overflow-hidden">
                        <div className="relative flex-shrink-0">
                          <div className="w-10 h-10 rounded-xl bg-violet-600/10 dark:bg-violet-400/10 text-violet-600 dark:text-violet-400 flex items-center justify-center font-bold text-sm">
                            {acc.displayName ? acc.displayName.charAt(0).toUpperCase() : 'A'}
                          </div>
                          <span className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white dark:border-slate-900 ${
                            isOnline ? 'bg-emerald-500' : 'bg-rose-500'
                          }`} />
                        </div>
                        <div className="min-w-0">
                          <h3 className="font-semibold text-slate-900 dark:text-white text-sm truncate">{acc.displayName}</h3>
                          <p className="text-xs text-slate-500 dark:text-slate-400 font-mono">UID: {acc.uid}</p>
                        </div>
                      </div>
                      <ChevronRight className={`w-4 h-4 text-slate-400 transition-transform ${isSelected ? 'translate-x-0.5 text-violet-600 dark:text-violet-400' : ''}`} />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Selected Account Control Panel */}
        <div className="lg:col-span-8 space-y-6">
          {selectedAccount ? (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm overflow-hidden">
              {/* Account Header Bar */}
              <div className="p-6 border-b border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-50/50 dark:bg-slate-800/30">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-2xl bg-violet-600 text-white font-bold text-lg flex items-center justify-center shadow-md">
                    {selectedAccount.displayName.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-xl font-bold text-slate-900 dark:text-white">{selectedAccount.displayName}</h2>
                      <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                        selectedAccount.status === 'CONNECTED' || selectedAccount.status === 'MQTT_LISTENING'
                          ? 'bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300'
                          : 'bg-rose-100 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300'
                      }`}>
                        {selectedAccount.status}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 font-mono mt-0.5">
                      UID: {selectedAccount.uid} • Provider: {selectedAccount.activeProviderName}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={() => handleToggle(selectedAccount.accountId, selectedAccount.enabled)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all ${
                      selectedAccount.enabled
                        ? 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 hover:bg-emerald-100'
                        : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-300 dark:border-slate-700'
                    }`}
                  >
                    <Power className="w-3.5 h-3.5" />
                    {selectedAccount.enabled ? 'Enabled' : 'Disabled'}
                  </button>

                  <button
                    onClick={() => handleReconnect(selectedAccount.accountId)}
                    className="p-2 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 rounded-xl transition-all"
                    title="Reconnect Account & MQTT"
                  >
                    <RefreshCw className="w-4 h-4" />
                  </button>

                  <button
                    onClick={() => handleDisconnect(selectedAccount.accountId)}
                    className="p-2 bg-amber-50 hover:bg-amber-100 dark:bg-amber-950/50 dark:hover:bg-amber-900 text-amber-700 dark:text-amber-300 rounded-xl transition-all"
                    title="Disconnect"
                  >
                    <Lock className="w-4 h-4" />
                  </button>

                  <button
                    onClick={() => handleDelete(selectedAccount.accountId)}
                    className="p-2 bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/50 dark:hover:bg-rose-900 text-rose-700 dark:text-rose-300 rounded-xl transition-all"
                    title="Delete Account"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Navigation Tabs */}
              <div className="flex border-b border-slate-200 dark:border-slate-800 px-6 gap-8 bg-white dark:bg-slate-900">
                <button
                  onClick={() => setActiveTab('overview')}
                  className={`py-3.5 text-sm font-semibold border-b-2 transition-all flex items-center gap-2 ${
                    activeTab === 'overview'
                      ? 'border-violet-600 text-violet-600 dark:text-violet-400'
                      : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-300'
                  }`}
                >
                  <Activity className="w-4 h-4" />
                  Overview & Stats
                </button>
                <button
                  onClick={() => setActiveTab('console')}
                  className={`py-3.5 text-sm font-semibold border-b-2 transition-all flex items-center gap-2 ${
                    activeTab === 'console'
                      ? 'border-violet-600 text-violet-600 dark:text-violet-400'
                      : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-300'
                  }`}
                >
                  <Terminal className="w-4 h-4" />
                  Live Console Stream
                  <span className="px-1.5 py-0.2 bg-violet-100 dark:bg-violet-950 text-violet-600 dark:text-violet-400 text-xs rounded-full">
                    {selectedAccount.liveConsoleLogs?.length || 0}
                  </span>
                </button>
                <button
                  onClick={() => setActiveTab('settings')}
                  className={`py-3.5 text-sm font-semibold border-b-2 transition-all flex items-center gap-2 ${
                    activeTab === 'settings'
                      ? 'border-violet-600 text-violet-600 dark:text-violet-400'
                      : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-300'
                  }`}
                >
                  <Sliders className="w-4 h-4" />
                  Assistant Settings
                </button>
              </div>

              {/* Tab Content */}
              <div className="p-6">
                {activeTab === 'overview' && (
                  <div className="space-y-6">
                    {/* Stat Cards Grid */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                      <div className="p-4 bg-slate-50 dark:bg-slate-800/50 border border-slate-200/80 dark:border-slate-700/80 rounded-xl">
                        <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 text-xs font-semibold mb-2">
                          <span>Total Conversations</span>
                          <MessageSquare className="w-4 h-4 text-violet-500" />
                        </div>
                        <div className="text-2xl font-bold text-slate-900 dark:text-white">
                          {selectedAccount.totalConversations}
                        </div>
                        <p className="text-xs text-slate-400 mt-1">Isolated private inbox chats</p>
                      </div>

                      <div className="p-4 bg-slate-50 dark:bg-slate-800/50 border border-slate-200/80 dark:border-slate-700/80 rounded-xl">
                        <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 text-xs font-semibold mb-2">
                          <span>Messages Today</span>
                          <Users className="w-4 h-4 text-emerald-500" />
                        </div>
                        <div className="text-2xl font-bold text-slate-900 dark:text-white">
                          {selectedAccount.messagesReceivedToday} <span className="text-xs font-normal text-slate-400">rcvd</span> / {selectedAccount.messagesRepliedToday} <span className="text-xs font-normal text-slate-400">replied</span>
                        </div>
                        <p className="text-xs text-slate-400 mt-1">AI auto-replies dispatched</p>
                      </div>

                      <div className="p-4 bg-slate-50 dark:bg-slate-800/50 border border-slate-200/80 dark:border-slate-700/80 rounded-xl">
                        <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 text-xs font-semibold mb-2">
                          <span>Avg Response Time</span>
                          <Clock className="w-4 h-4 text-amber-500" />
                        </div>
                        <div className="text-2xl font-bold text-slate-900 dark:text-white">
                          {selectedAccount.avgResponseTimeMs}ms
                        </div>
                        <p className="text-xs text-slate-400 mt-1">Context Engine latency</p>
                      </div>

                      <div className="p-4 bg-slate-50 dark:bg-slate-800/50 border border-slate-200/80 dark:border-slate-700/80 rounded-xl">
                        <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 text-xs font-semibold mb-2">
                          <span>AI Model</span>
                          <Cpu className="w-4 h-4 text-indigo-500" />
                        </div>
                        <div className="text-lg font-bold text-slate-900 dark:text-white truncate">
                          {selectedAccount.aiModel}
                        </div>
                        <p className="text-xs text-slate-400 mt-1">Memory Size: {selectedAccount.memorySize} items</p>
                      </div>
                    </div>

                    {/* Detailed Diagnostics Info */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2">
                      <div className="bg-slate-50 dark:bg-slate-800/40 p-5 rounded-2xl border border-slate-200 dark:border-slate-700 space-y-3">
                        <h3 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                          <Shield className="w-4 h-4 text-violet-600" />
                          Session & MQTT Status
                        </h3>
                        <div className="space-y-2 text-sm">
                          <div className="flex justify-between py-1 border-b border-slate-200 dark:border-slate-700/60">
                            <span className="text-slate-500">MQTT Stream:</span>
                            <span className="font-medium text-slate-900 dark:text-white">{selectedAccount.mqttStatus}</span>
                          </div>
                          <div className="flex justify-between py-1 border-b border-slate-200 dark:border-slate-700/60">
                            <span className="text-slate-500">Session Uptime:</span>
                            <span className="font-medium text-slate-900 dark:text-white">{selectedAccount.sessionUptime}s</span>
                          </div>
                          <div className="flex justify-between py-1 border-b border-slate-200 dark:border-slate-700/60">
                            <span className="text-slate-500">Reconnect Count:</span>
                            <span className="font-medium text-slate-900 dark:text-white">{selectedAccount.reconnectCount}</span>
                          </div>
                          <div className="flex justify-between py-1">
                            <span className="text-slate-500">Error Count:</span>
                            <span className="font-medium text-rose-600">{selectedAccount.errorCount}</span>
                          </div>
                        </div>
                      </div>

                      <div className="bg-slate-50 dark:bg-slate-800/40 p-5 rounded-2xl border border-slate-200 dark:border-slate-700 space-y-3">
                        <h3 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                          <Activity className="w-4 h-4 text-emerald-600" />
                          Timing & Timestamps
                        </h3>
                        <div className="space-y-2 text-sm">
                          <div className="flex justify-between py-1 border-b border-slate-200 dark:border-slate-700/60">
                            <span className="text-slate-500">Last Incoming Message:</span>
                            <span className="font-medium text-slate-900 dark:text-white">{formatTimestamp(selectedAccount.lastIncomingMessageTime)}</span>
                          </div>
                          <div className="flex justify-between py-1 border-b border-slate-200 dark:border-slate-700/60">
                            <span className="text-slate-500">Last Outgoing Reply:</span>
                            <span className="font-medium text-slate-900 dark:text-white">{formatTimestamp(selectedAccount.lastOutgoingReplyTime)}</span>
                          </div>
                          <div className="flex justify-between py-1 border-b border-slate-200 dark:border-slate-700/60">
                            <span className="text-slate-500">Last Validated At:</span>
                            <span className="font-medium text-slate-900 dark:text-white">{formatTimestamp(selectedAccount.lastValidatedAt ? new Date(selectedAccount.lastValidatedAt).getTime() : 0)}</span>
                          </div>
                          <div className="flex justify-between py-1">
                            <span className="text-slate-500">Last Error Code:</span>
                            <span className="font-mono text-xs text-rose-600">{selectedAccount.lastErrorCode || 'None'}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {activeTab === 'console' && (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <p className="text-sm text-slate-500 dark:text-slate-400">
                        Real-time execution logs for authentication, MQTT event stream, and AI context processing.
                      </p>
                      <button
                        onClick={() => handleClearLogs(selectedAccount.accountId)}
                        className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 text-xs font-semibold rounded-lg transition-all"
                      >
                        Clear Logs
                      </button>
                    </div>

                    <div className="bg-slate-950 text-slate-200 font-mono text-xs p-4 rounded-2xl h-96 overflow-y-auto space-y-2 border border-slate-800 shadow-inner">
                      {(!selectedAccount.liveConsoleLogs || selectedAccount.liveConsoleLogs.length === 0) ? (
                        <div className="text-slate-600 text-center py-24">No console logs recorded yet. Waiting for events...</div>
                      ) : (
                        selectedAccount.liveConsoleLogs.map((log) => {
                          let badgeColor = 'bg-blue-500/10 text-blue-400 border-blue-500/20';
                          if (log.type === 'SUCCESS') badgeColor = 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
                          if (log.type === 'ERROR') badgeColor = 'bg-rose-500/10 text-rose-400 border-rose-500/20';
                          if (log.type === 'WARN') badgeColor = 'bg-amber-500/10 text-amber-400 border-amber-500/20';
                          if (log.type === 'AUTH') badgeColor = 'bg-purple-500/10 text-purple-400 border-purple-500/20';
                          if (log.type === 'MQTT') badgeColor = 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20';

                          return (
                            <div key={log.id} className="flex items-start gap-3 border-b border-slate-900 pb-2">
                              <span className="text-slate-500 text-[10px] whitespace-nowrap pt-0.5">
                                {new Date(log.timestamp).toLocaleTimeString()}
                              </span>
                              <span className={`px-2 py-0.5 text-[10px] font-bold rounded border uppercase ${badgeColor}`}>
                                {log.type}
                              </span>
                              <span className="text-slate-300 break-all leading-relaxed">{log.message}</span>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                )}

                {activeTab === 'settings' && (
                  <form onSubmit={handleSaveSettings} className="space-y-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="space-y-4">
                        <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Behavior & Automation</h3>

                        <div className="flex items-center justify-between p-3.5 bg-slate-50 dark:bg-slate-800/40 rounded-xl border border-slate-200 dark:border-slate-700">
                          <div>
                            <span className="font-medium text-sm text-slate-900 dark:text-white block">Auto-Reply Enabled</span>
                            <span className="text-xs text-slate-500">Automatically reply to private messages using ShiPu AI</span>
                          </div>
                          <input
                            type="checkbox"
                            checked={settingsForm.autoReplyEnabled ?? true}
                            onChange={(e) => setSettingsForm({ ...settingsForm, autoReplyEnabled: e.target.checked })}
                            className="w-5 h-5 text-violet-600 rounded border-slate-300 focus:ring-violet-500"
                          />
                        </div>

                        <div className="flex items-center justify-between p-3.5 bg-slate-50 dark:bg-slate-800/40 rounded-xl border border-slate-200 dark:border-slate-700">
                          <div>
                            <span className="font-medium text-sm text-slate-900 dark:text-white block">Typing Indicator</span>
                            <span className="text-xs text-slate-500">Show typing animation before sending AI response</span>
                          </div>
                          <input
                            type="checkbox"
                            checked={settingsForm.typingIndicatorEnabled ?? true}
                            onChange={(e) => setSettingsForm({ ...settingsForm, typingIndicatorEnabled: e.target.checked })}
                            className="w-5 h-5 text-violet-600 rounded border-slate-300 focus:ring-violet-500"
                          />
                        </div>

                        <div className="flex items-center justify-between p-3.5 bg-slate-50 dark:bg-slate-800/40 rounded-xl border border-slate-200 dark:border-slate-700">
                          <div>
                            <span className="font-medium text-sm text-slate-900 dark:text-white block">Ignore Group Chats</span>
                            <span className="text-xs text-slate-500">Restrict AI assistant strictly to private inbox conversations</span>
                          </div>
                          <input
                            type="checkbox"
                            checked={settingsForm.ignoreGroupChats ?? true}
                            onChange={(e) => setSettingsForm({ ...settingsForm, ignoreGroupChats: e.target.checked })}
                            className="w-5 h-5 text-violet-600 rounded border-slate-300 focus:ring-violet-500"
                          />
                        </div>

                        <div className="flex items-center justify-between p-3.5 bg-slate-50 dark:bg-slate-800/40 rounded-xl border border-slate-200 dark:border-slate-700">
                          <div>
                            <span className="font-medium text-sm text-slate-900 dark:text-white block">Auto Sleep Mode</span>
                            <span className="text-xs text-slate-500">Temporarily pause AI replies without disconnecting</span>
                          </div>
                          <input
                            type="checkbox"
                            checked={settingsForm.autoSleepMode ?? false}
                            onChange={(e) => setSettingsForm({ ...settingsForm, autoSleepMode: e.target.checked })}
                            className="w-5 h-5 text-violet-600 rounded border-slate-300 focus:ring-violet-500"
                          />
                        </div>
                      </div>

                      <div className="space-y-4">
                        <h3 className="text-sm font-semibold text-slate-900 dark:text-white">AI Engine & Performance</h3>

                        <div>
                          <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5">AI Model</label>
                          <select
                            value={settingsForm.aiModel || 'gemma-4-26b-a4b-it'}
                            onChange={(e) => setSettingsForm({ ...settingsForm, aiModel: e.target.value })}
                            className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-xl text-sm text-slate-900 dark:text-white"
                          >
                            <option value="gemma-4-26b-a4b-it">Gemini 3.6 Flash (Recommended)</option>
                            <option value="gemma-4-26b-a4b-it">Gemini 2.5 Flash</option>
                            <option value="gemma-4-26b-a4b-it">Gemini 2.5 Pro</option>
                            <option value="gemma-4-26b-a4b-it">Gemini Flash Latest</option>
                          </select>
                        </div>

                        <div>
                          <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5">Reply Delay (ms)</label>
                          <input
                            type="number"
                            value={settingsForm.replyDelayMs ?? 1000}
                            onChange={(e) => setSettingsForm({ ...settingsForm, replyDelayMs: parseInt(e.target.value) || 0 })}
                            className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-xl text-sm text-slate-900 dark:text-white font-mono"
                          />
                          <p className="text-[11px] text-slate-400 mt-1">Simulates human typing speed before sending response.</p>
                        </div>

                        <div>
                          <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5">Memory History Size</label>
                          <input
                            type="number"
                            value={settingsForm.memorySize ?? 10}
                            onChange={(e) => setSettingsForm({ ...settingsForm, memorySize: parseInt(e.target.value) || 5 })}
                            className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-xl text-sm text-slate-900 dark:text-white font-mono"
                          />
                          <p className="text-[11px] text-slate-400 mt-1">Number of past messages included in context for the LLM.</p>
                        </div>
                      </div>
                    </div>

                    <div className="pt-4 border-t border-slate-200 dark:border-slate-800 flex justify-end">
                      <button
                        type="submit"
                        className="px-6 py-2.5 bg-violet-600 hover:bg-violet-700 text-white font-medium rounded-xl shadow-sm transition-all"
                      >
                        Save Settings
                      </button>
                    </div>
                  </form>
                )}
              </div>
            </div>
          ) : (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-16 text-center shadow-sm">
              <Bot className="w-16 h-16 text-slate-300 dark:text-slate-700 mx-auto mb-4" />
              <h2 className="text-lg font-bold text-slate-900 dark:text-white mb-1">No Assistant Selected</h2>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Select an assistant from the sidebar or register a new one to view its control panel.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Registration Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4">
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl max-w-xl w-full p-6 shadow-2xl space-y-6"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-3 bg-violet-50 dark:bg-violet-950 text-violet-600 rounded-2xl">
                  <Key className="w-6 h-6" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-slate-900 dark:text-white">Register Personal AI Assistant</h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400">Paste Facebook AppState cookie JSON to connect account</p>
                </div>
              </div>
              <button 
                onClick={() => setShowAddModal(false)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-2 rounded-xl"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleRegisterCookie} className="space-y-4">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-semibold text-slate-600 dark:text-slate-400">AppState Cookie JSON</label>
                  <label className="cursor-pointer text-xs font-semibold text-violet-600 dark:text-violet-400 hover:underline flex items-center gap-1">
                    <Upload className="w-3.5 h-3.5" />
                    Upload Cookie File (.json)
                    <input type="file" accept=".json" onChange={handleFileUpload} className="hidden" />
                  </label>
                </div>
                <textarea
                  rows={8}
                  placeholder={`[{"key": "c_user", "value": "..."}, {"key": "xs", "value": "..."}]`}
                  value={cookieJsonInput}
                  onChange={(e) => setCookieJsonInput(e.target.value)}
                  className="w-full font-mono text-xs bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-2xl p-4 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
                />
              </div>

              {errorMsg && (
                <div className="p-3 bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300 rounded-xl text-xs flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                  <span>{errorMsg}</span>
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-5 py-2.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 font-medium rounded-xl text-sm transition-all"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isRegistering}
                  className="px-6 py-2.5 bg-violet-600 hover:bg-violet-700 text-white font-medium rounded-xl text-sm shadow-sm transition-all disabled:opacity-50 flex items-center gap-2"
                >
                  {isRegistering ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      Connecting...
                    </>
                  ) : (
                    'Connect Assistant'
                  )}
                </button>
              </div>
            </form>
          </motion.div>
        </div>
      )}
    </div>
  );
};
