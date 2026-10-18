import React, { useState, useEffect, useCallback } from 'react';
import { 
  Plus, 
  Edit2, 
  Trash2, 
  Play, 
  Check, 
  X, 
  RefreshCw, 
  AlertTriangle, 
  CheckCircle2, 
  Database, 
  Key, 
  Cpu, 
  Layers, 
  Activity, 
  Power,
  Sliders,
  Sparkles,
  Link,
  ShieldCheck
} from 'lucide-react';

interface FallbackApi {
  _id: string;
  name: string;
  url: string;
  apiKey: string;
  model: string;
  enabled: boolean;
  priority: number;
  successCount: number;
  failCount: number;
  lastUsedAt?: string;
  lastError?: string;
  createdAt: string;
}

interface PingStatus {
  status: 'online' | 'offline' | 'checking' | 'unknown';
  latencyMs?: number;
  lastChecked?: Date;
  error?: string;
}

interface FallbackApiManagerProps {
  token: string;
}

export const FallbackApiManager: React.FC<FallbackApiManagerProps> = React.memo(({ token }) => {
  const [apis, setApis] = useState<FallbackApi[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [pingStatuses, setPingStatuses] = useState<Record<string, PingStatus>>({});

  // Form State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingApi, setEditingApi] = useState<FallbackApi | null>(null);
  const [formName, setFormName] = useState('');
  const [formUrl, setFormUrl] = useState('');
  const [formApiKey, setFormApiKey] = useState('');
  const [formModel, setFormModel] = useState('gemma-4-26b-a4b-it');
  const [formEnabled, setFormEnabled] = useState(true);
  const [formPriority, setFormPriority] = useState(0);

  // Connection Test State
  const [testingApiId, setTestingApiId] = useState<string | null>(null);
  const [testResponse, setTestResponse] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [testPrompt, setTestPrompt] = useState('Explain how AI works in 5 words');

  const showToast = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const fetchApis = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/fallback-apis', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) {
        throw new Error(`Failed to load APIs (HTTP ${response.status})`);
      }
      const data = await response.json();
      setApis(data);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'An error occurred while fetching fallback APIs.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  const pingApi = useCallback(async (api: FallbackApi) => {
    setPingStatuses(prev => ({
      ...prev,
      [api._id]: { status: 'checking', lastChecked: new Date() }
    }));

    const startTime = Date.now();
    try {
      const response = await fetch('/api/fallback-apis/test-connection', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          url: api.url,
          apiKey: api.apiKey,
          model: api.model,
          prompt: 'ping'
        })
      });

      const latencyMs = Date.now() - startTime;
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || `HTTP error ${response.status}`);
      }

      setPingStatuses(prev => ({
        ...prev,
        [api._id]: {
          status: 'online',
          latencyMs,
          lastChecked: new Date()
        }
      }));
    } catch (err: any) {
      setPingStatuses(prev => ({
        ...prev,
        [api._id]: {
          status: 'offline',
          lastChecked: new Date(),
          error: err.message || 'Connection failed'
        }
      }));
    }
  }, [token]);

  useEffect(() => {
    fetchApis();
  }, [fetchApis]);

  // Trigger initial pings when apis are fetched/loaded
  useEffect(() => {
    if (apis.length > 0) {
      apis.forEach(api => {
        if (api.enabled) {
          pingApi(api);
        }
      });
    }
  }, [apis, pingApi]);

  // Setup periodic checks every 2 minutes when tab is visible
  useEffect(() => {
    if (apis.length === 0) return;

    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        apis.forEach(api => {
          if (api.enabled) {
            pingApi(api);
          }
        });
      }
    }, 120000);

    return () => clearInterval(interval);
  }, [apis, pingApi]);

  const handleOpenAddModal = () => {
    setEditingApi(null);
    setFormName('');
    setFormUrl('https://generativelanguage.googleapis.com/v1beta/models/gemma-4-26b-a4b-it:generateContent');
    setFormApiKey('');
    setFormModel('gemma-4-26b-a4b-it');
    setFormEnabled(true);
    setFormPriority(0);
    setIsModalOpen(true);
  };

  const handleOpenEditModal = (api: FallbackApi) => {
    setEditingApi(api);
    setFormName(api.name);
    setFormUrl(api.url);
    setFormApiKey(api.apiKey);
    setFormModel(api.model);
    setFormEnabled(api.enabled);
    setFormPriority(api.priority);
    setIsModalOpen(true);
  };

  const handleSaveApi = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim() || !formUrl.trim() || !formApiKey.trim()) {
      showToast('Please fill out all required fields.', 'error');
      return;
    }

    const payload = {
      name: formName,
      url: formUrl,
      apiKey: formApiKey,
      model: formModel,
      enabled: formEnabled,
      priority: Number(formPriority)
    };

    try {
      let response;
      if (editingApi) {
        // Edit Mode
        response = await fetch(`/api/fallback-apis/${editingApi._id}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify(payload)
        });
      } else {
        // Create Mode
        response = await fetch('/api/fallback-apis', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify(payload)
        });
      }

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to save fallback API configuration.');
      }

      showToast(
        editingApi 
          ? `Successfully updated fallback API "${formName}"` 
          : `Successfully added fallback API "${formName}"`
      );
      setIsModalOpen(false);
      fetchApis();
    } catch (err: any) {
      showToast(err.message || 'Error occurred while saving API.', 'error');
    }
  };

  const handleDeleteApi = async (id: string, name: string) => {
    if (!window.confirm(`Are you sure you want to delete fallback API "${name}"?`)) {
      return;
    }

    try {
      const response = await fetch(`/api/fallback-apis/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to delete fallback API.');
      }
      showToast(`Successfully deleted fallback API "${name}"`);
      fetchApis();
    } catch (err: any) {
      showToast(err.message || 'Error deleting API.', 'error');
    }
  };

  const handleToggleEnable = async (api: FallbackApi) => {
    try {
      const response = await fetch(`/api/fallback-apis/${api._id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ enabled: !api.enabled })
      });
      if (!response.ok) {
        throw new Error('Failed to toggle status.');
      }
      showToast(`Fallback API "${api.name}" is now ${!api.enabled ? 'Enabled' : 'Disabled'}`);
      fetchApis();
    } catch (err: any) {
      showToast(err.message || 'Error toggling status.', 'error');
    }
  };

  const handleTestConnection = async (api: FallbackApi) => {
    setTestingApiId(api._id);
    setTestResponse(null);
    setTestError(null);

    try {
      const response = await fetch('/api/fallback-apis/test-connection', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          url: api.url,
          apiKey: api.apiKey,
          model: api.model,
          prompt: testPrompt
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'API response rejected.');
      }

      setTestResponse(data.text);
    } catch (err: any) {
      setTestError(err.message || 'Connection test failed.');
    } finally {
      setTestingApiId(null);
    }
  };

  const formatPercentage = (success: number, total: number) => {
    if (total === 0) return '0%';
    return `${Math.round((success / total) * 100)}%`;
  };

  return (
    <div className="space-y-6">
      
      {/* Toast Notification */}
      {toast && (
        <div className={`fixed bottom-4 right-4 z-50 px-4 py-3 rounded-lg shadow-lg flex items-center gap-2 border text-xs font-semibold animate-bounce ${
          toast.type === 'success' 
            ? 'bg-emerald-950/90 text-emerald-400 border-emerald-500/30' 
            : 'bg-rose-950/90 text-rose-400 border-rose-500/30'
        }`}>
          {toast.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
          <span>{toast.message}</span>
        </div>
      )}

      {/* Header section */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-900 border border-slate-800 rounded-xl p-6">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 shrink-0">
            <Sliders className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
              Fallback API Pool Manager
            </h2>
            <p className="text-sm text-slate-400">
              Configure unlimited load-balanced backup APIs to maintain 100% service uptime when primary quotas exhaust
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 self-start sm:self-center">
          <button
            onClick={() => {
              const enabledApis = apis.filter(a => a.enabled);
              if (enabledApis.length === 0) {
                showToast('No enabled fallback routes to check', 'error');
                return;
              }
              enabledApis.forEach(api => pingApi(api));
              showToast('Triggered live handshake validation for all active pools');
            }}
            className="flex items-center justify-center gap-1.5 px-3 py-2.5 bg-slate-850 hover:bg-slate-800 text-slate-200 border border-slate-700 font-semibold text-xs rounded-lg transition"
          >
            <RefreshCw className="w-3.5 h-3.5 text-indigo-400 animate-spin" style={{ animationDuration: '3s' }} />
            <span>Validate All Pools</span>
          </button>
          <button
            onClick={handleOpenAddModal}
            className="flex items-center justify-center gap-1.5 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs rounded-lg transition shadow-lg shadow-indigo-600/20 shrink-0"
          >
            <Plus className="w-4 h-4" />
            <span>Add Fallback API</span>
          </button>
        </div>
      </div>

      {/* Connection Test Prompt Controller */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-slate-200 text-xs flex items-center gap-1.5">
            <Activity className="w-4 h-4 text-emerald-400 animate-pulse" />
            <span>Connection Tester Options</span>
          </h3>
          <span className="text-[10px] text-slate-400 bg-slate-950 px-2 py-0.5 rounded border border-slate-800 font-mono">Live Diagnostics</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-center">
          <div className="md:col-span-3">
            <input
              type="text"
              value={testPrompt}
              onChange={e => setTestPrompt(e.target.value)}
              placeholder="Test prompt payload..."
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-300 font-medium focus:outline-none focus:border-indigo-500"
            />
          </div>
          <div className="text-[11px] text-slate-400 italic">
            This prompt will be sent when clicking "Test Connection" on any route card.
          </div>
        </div>
        {(testResponse || testError) && (
          <div className={`p-3 rounded-lg border text-xs font-mono max-h-24 overflow-y-auto ${
            testError 
              ? 'bg-rose-950/30 text-rose-400 border-rose-500/20' 
              : 'bg-emerald-950/30 text-emerald-400 border-emerald-500/20'
          }`}>
            <span className="font-bold block text-[10px] mb-1 tracking-wider uppercase">
              {testError ? '❌ Diagnostic Failure' : '✅ Connection Success response'}
            </span>
            <span className="whitespace-pre-wrap">{testError || testResponse}</span>
          </div>
        )}
      </div>

      {/* 429 Quota Alert / Explainer Box */}
      <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-5 space-y-3">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-lg bg-amber-500/20 flex items-center justify-center text-amber-400 shrink-0 mt-0.5">
            <AlertTriangle className="w-4 h-4" />
          </div>
          <div className="space-y-1">
            <h4 className="text-sm font-bold text-amber-300">How to Fix "HTTP 429 (RESOURCE_EXHAUSTED)" Errors</h4>
            <p className="text-xs text-slate-300 leading-relaxed">
              Google free-tier API keys are hard-capped at **20 requests per minute/day**. When multiple people test or run tasks, this quota gets instantly consumed.
            </p>
            <div className="pt-2 flex flex-col gap-1.5 text-[11px] text-slate-400">
              <p>💡 **Uptime Solution**: Go to <a href="https://aistudio.google.com/" target="_blank" rel="noreferrer" className="text-indigo-400 hover:underline font-semibold">Google AI Studio</a>, generate a fresh free API key, and register it below.</p>
              <p>🔄 **Automatic Failover**: If you register 2 or more keys, our system will automatically bypass any rate-limited key and failover to your other active keys in real-time without losing conversation context!</p>
            </div>
          </div>
        </div>
      </div>

      {/* Main List */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-16 text-slate-400 bg-slate-900 border border-slate-800 rounded-xl gap-3">
          <RefreshCw className="w-8 h-8 text-indigo-400 animate-spin" />
          <span className="text-xs">Loading Fallback API catalog...</span>
        </div>
      ) : error ? (
        <div className="p-6 bg-rose-950/20 border border-rose-500/20 text-rose-400 rounded-xl text-center space-y-3">
          <AlertTriangle className="w-10 h-10 mx-auto text-rose-500" />
          <p className="text-xs font-medium">{error}</p>
          <button
            onClick={fetchApis}
            className="px-4 py-2 bg-rose-500 hover:bg-rose-400 text-white rounded-lg text-xs font-semibold"
          >
            Retry Connection
          </button>
        </div>
      ) : apis.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-slate-500 bg-slate-900 border border-slate-800 rounded-xl gap-4 text-center px-4">
          <Database className="w-12 h-12 text-slate-700" />
          <div>
            <h4 className="text-slate-300 font-bold text-sm">No Fallback APIs configured</h4>
            <p className="text-xs text-slate-500 mt-1 max-w-md">
              Start by adding your first custom fallback API key or endpoint model to establish an automated load balanced pool.
            </p>
          </div>
          <button
            onClick={handleOpenAddModal}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs rounded-lg transition"
          >
            Create API Configuration
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {apis.map((api) => {
            const totalRequests = api.successCount + api.failCount;
            return (
              <div 
                key={api._id}
                className={`bg-slate-900 border rounded-xl p-5 transition flex flex-col space-y-4 ${
                  api.enabled 
                    ? 'border-slate-800 hover:border-indigo-500/40' 
                    : 'border-slate-850 opacity-60 bg-slate-900/50'
                }`}
              >
                
                {/* Header info */}
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-slate-100 text-sm">{api.name}</span>
                      <span className="text-[10px] bg-indigo-600/20 text-indigo-400 px-2 py-0.5 rounded border border-indigo-500/20 font-mono font-semibold">
                        P{api.priority}
                      </span>
                      {api.successCount > 0 && api.failCount === 0 && (
                        <span className="text-[10px] bg-emerald-500/10 text-emerald-400 px-2 py-0.5 rounded border border-emerald-500/20">
                          100% Success
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-slate-400">
                      <Cpu className="w-3.5 h-3.5 text-slate-500" />
                      <span className="font-mono">{api.model}</span>
                    </div>
                  </div>

                  {/* Actions right */}
                  <div className="flex items-center space-x-1">
                    <button
                      onClick={() => handleToggleEnable(api)}
                      title={api.enabled ? 'Disable API' : 'Enable API'}
                      className={`p-1.5 rounded-lg border transition ${
                        api.enabled 
                          ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20' 
                          : 'bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700'
                      }`}
                    >
                      <Power className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleOpenEditModal(api)}
                      title="Edit Configuration"
                      className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg border border-slate-700 transition"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleDeleteApi(api._id, api.name)}
                      title="Delete API"
                      className="p-1.5 bg-slate-800 hover:bg-rose-950 hover:text-rose-400 text-slate-400 rounded-lg border border-slate-700 hover:border-rose-900 transition"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* API Details endpoint and key */}
                <div className="bg-slate-950 border border-slate-850 rounded-lg p-3 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-500 flex items-center gap-1">
                      <Link className="w-3 h-3 text-slate-600" /> Endpoint:
                    </span>
                    <div className="flex items-center gap-2">
                      {/* Connection status indicator */}
                      {(() => {
                        const ping = pingStatuses[api._id];
                        if (!api.enabled) {
                          return (
                            <span className="flex items-center gap-1 text-[10px] text-slate-500" title="This backup route is disabled">
                              <span className="w-2 h-2 rounded-full bg-slate-600"></span>
                              <span>Disabled</span>
                            </span>
                          );
                        }
                        if (!ping) {
                          return (
                            <span className="flex items-center gap-1 text-[10px] text-slate-400" title="Awaiting first ping validation">
                              <span className="w-2 h-2 rounded-full bg-slate-500 animate-pulse"></span>
                              <span>Awaiting</span>
                            </span>
                          );
                        }
                        if (ping.status === 'checking') {
                          return (
                            <span className="flex items-center gap-1 text-[10px] text-amber-400" title="Actively verifying connection health">
                              <RefreshCw className="w-2.5 h-2.5 animate-spin" />
                              <span>Checking</span>
                            </span>
                          );
                        }
                        if (ping.status === 'online') {
                          return (
                            <span className="flex items-center gap-1 text-[10px] text-emerald-400 font-semibold" title={`Online! Handshake took ${ping.latencyMs}ms`}>
                              <span className="relative flex h-2 w-2">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                              </span>
                              <span>{ping.latencyMs}ms</span>
                            </span>
                          );
                        }
                        return (
                          <span className="flex items-center gap-1 text-[10px] text-rose-400 font-semibold" title={`Offline: ${ping.error}`}>
                            <span className="relative flex h-2 w-2">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                              <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500"></span>
                            </span>
                            <span>Offline</span>
                          </span>
                        );
                      })()}
                      <span className="font-mono text-slate-300 max-w-[180px] sm:max-w-[220px] truncate" title={api.url}>
                        {api.url}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-500 flex items-center gap-1">
                      <Key className="w-3 h-3 text-slate-600" /> API Key:
                    </span>
                    <span className="font-mono text-slate-300">
                      {api.apiKey ? `${api.apiKey.substring(0, 5)}...${api.apiKey.substring(api.apiKey.length - 4)}` : 'N/A'}
                    </span>
                  </div>

                  {(() => {
                    const ping = pingStatuses[api._id];
                    if (ping && ping.status === 'offline' && ping.error) {
                      return (
                        <div className="text-[10px] text-rose-400 bg-rose-500/5 border border-rose-500/10 rounded p-1.5 flex items-start gap-1 font-mono">
                          <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0 mt-0.5" />
                          <span className="break-all" title={ping.error}>Error: {ping.error}</span>
                        </div>
                      );
                    }
                    return null;
                  })()}
                </div>

                {/* Stats row */}
                <div className="grid grid-cols-3 gap-2 text-center text-xs">
                  <div className="bg-slate-950/40 border border-slate-800 rounded-lg p-2">
                    <span className="text-[10px] text-slate-500 block uppercase font-semibold">Hits Succeeded</span>
                    <span className="text-emerald-400 font-bold font-mono text-sm mt-0.5 block">{api.successCount}</span>
                  </div>
                  <div className="bg-slate-950/40 border border-slate-800 rounded-lg p-2">
                    <span className="text-[10px] text-slate-500 block uppercase font-semibold">Hits Failed</span>
                    <span className={`${api.failCount > 0 ? 'text-rose-400' : 'text-slate-400'} font-bold font-mono text-sm mt-0.5 block`}>
                      {api.failCount}
                    </span>
                  </div>
                  <div className="bg-slate-950/40 border border-slate-800 rounded-lg p-2">
                    <span className="text-[10px] text-slate-500 block uppercase font-semibold">Reliability</span>
                    <span className="text-indigo-400 font-bold font-mono text-sm mt-0.5 block">
                      {formatPercentage(api.successCount, totalRequests)}
                    </span>
                  </div>
                </div>

                {/* Last Used & Diagnostics */}
                <div className="text-[11px] text-slate-400 flex flex-col space-y-1 pt-1 border-t border-slate-850">
                  <div className="flex justify-between">
                    <span>Last Activated:</span>
                    <span className="font-mono text-slate-300">
                      {api.lastUsedAt ? new Date(api.lastUsedAt).toLocaleString() : 'Never'}
                    </span>
                  </div>
                  {api.lastError && (
                    <div className="text-rose-400 bg-rose-950/20 px-2 py-1 rounded border border-rose-900/30 font-mono mt-1 max-h-16 overflow-y-auto">
                      <span className="font-bold">Last Error: </span>{api.lastError}
                    </div>
                  )}
                </div>

                {/* Diagnostic Tester action inside the card */}
                <button
                  onClick={() => handleTestConnection(api)}
                  disabled={testingApiId !== null || !api.enabled}
                  className="w-full mt-2 py-1.5 bg-slate-950 hover:bg-slate-850 text-slate-300 hover:text-white font-semibold text-[11px] rounded-lg border border-slate-800 transition flex items-center justify-center gap-1.5 disabled:opacity-40"
                >
                  {testingApiId === api._id ? (
                    <>
                      <RefreshCw className="w-3 h-3 animate-spin text-indigo-400" />
                      <span>Verifying Handshake...</span>
                    </>
                  ) : (
                    <>
                      <Play className="w-3 h-3 text-emerald-400 shrink-0" />
                      <span>Test Connection</span>
                    </>
                  )}
                </button>

              </div>
            );
          })}
        </div>
      )}

      {/* Modal Overlay for Add/Edit Fallback API */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 overflow-y-auto flex items-center justify-center bg-slate-950/85 backdrop-blur-sm p-4">
          <div className="relative bg-slate-900 border border-slate-800 w-full max-w-lg rounded-2xl shadow-2xl p-6 space-y-5 animate-in fade-in zoom-in duration-150">
            
            {/* Modal Header */}
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
                <Database className="w-5 h-5 text-indigo-400" />
                <span>{editingApi ? 'Modify Fallback API' : 'Register Fallback API'}</span>
              </h3>
              <button
                onClick={() => setIsModalOpen(false)}
                className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 rounded-lg border border-slate-700 transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Body */}
            <form onSubmit={handleSaveApi} className="space-y-4 text-xs font-semibold">
              
              <div>
                <label className="block text-slate-400 mb-1">Provider Route Name <span className="text-indigo-400 font-bold">*</span></label>
                <input
                  type="text"
                  required
                  value={formName}
                  onChange={e => setFormName(e.target.value)}
                  placeholder="e.g. Google Cloud Backup Link"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:border-indigo-500 font-medium"
                />
              </div>

              <div>
                <label className="block text-slate-400 mb-1">REST API URL <span className="text-indigo-400 font-bold">*</span></label>
                <input
                  type="url"
                  required
                  value={formUrl}
                  onChange={e => setFormUrl(e.target.value)}
                  placeholder="https://generativelanguage.googleapis.com/v1beta/models/...:generateContent"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
                />
              </div>

              <div>
                <label className="block text-slate-400 mb-1">API Authentication Key <span className="text-indigo-400 font-bold">*</span></label>
                <input
                  type="password"
                  required
                  value={formApiKey}
                  onChange={e => setFormApiKey(e.target.value)}
                  placeholder="Paste your API key here..."
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-slate-400 mb-1">Model ID</label>
                  <input
                    type="text"
                    value={formModel}
                    onChange={e => setFormModel(e.target.value)}
                    placeholder="gemma-4-26b-a4b-it"
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
                  />
                </div>

                <div>
                  <label className="block text-slate-400 mb-1">Activation Priority</label>
                  <input
                    type="number"
                    value={formPriority}
                    onChange={e => setFormPriority(Number(e.target.value))}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 pt-2">
                <input
                  type="checkbox"
                  id="formEnabled"
                  checked={formEnabled}
                  onChange={e => setFormEnabled(e.target.checked)}
                  className="rounded bg-slate-950 border-slate-800 text-indigo-600 focus:ring-indigo-500"
                />
                <label htmlFor="formEnabled" className="text-slate-300 select-none">
                  Enable Route in Failover Loop immediately
                </label>
              </div>

              {/* Modal Actions */}
              <div className="flex items-center justify-end space-x-3 pt-4 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg border border-slate-700 font-semibold transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-semibold transition shadow-lg shadow-indigo-600/20"
                >
                  {editingApi ? 'Save Changes' : 'Register Route'}
                </button>
              </div>

            </form>
          </div>
        </div>
      )}

    </div>
  );
});
