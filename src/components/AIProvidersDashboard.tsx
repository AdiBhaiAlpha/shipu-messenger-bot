import React, { useState, useEffect, useCallback } from 'react';
import { 
  Sparkles, 
  Key, 
  CheckCircle2, 
  XCircle, 
  AlertTriangle, 
  Loader2, 
  Save, 
  History, 
  RefreshCw, 
  Eye, 
  EyeOff, 
  Cpu, 
  Power,
  TrendingUp,
  AlertCircle
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { OPENROUTER_FREE_MODELS } from '../config/aiModels';

interface AIProvidersDashboardProps {
  token: string;
}

export interface AIConfigurationState {
  openRouterApiKey: string;
  defaultProvider: string;
  defaultModel: string;
  lastWorkingModel?: string;
  aiEnabled: boolean;
  status: 'Connected' | 'Invalid' | 'Rate Limited' | 'Offline';
  lastSuccessfulRequestTime?: string;
  lastError?: string;
  keyHistory: Array<{
    key: string;
    timestamp: string;
  }>;
}

const POPULAR_MODELS = OPENROUTER_FREE_MODELS.map(m => ({
  value: m.value,
  label: `${m.label}${m.context ? ` (${m.context})` : ''}`
}));

export const AIProvidersDashboard: React.FC<AIProvidersDashboardProps> = ({ token }) => {
  const [config, setConfig] = useState<AIConfigurationState | null>(null);
  const [newApiKey, setNewApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isRollingBack, setIsRollingBack] = useState<number | null>(null);
  const [testResult, setTestResult] = useState<{ success: boolean; status: string; error?: string } | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/ai-config', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (data.success) {
        setConfig(data.config);
        setNewApiKey(data.config.openRouterApiKey);
      } else {
        setFeedback({ type: 'error', message: data.error || 'Failed to fetch AI configuration' });
      }
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Network error fetching configuration' });
    }
  }, [token]);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/ai-config/test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ apiKey: newApiKey })
      });
      const text = await res.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        data = { success: false, status: 'Offline', error: `Server returned a non-JSON response (HTTP ${res.status}). The backend host may be asleep or unreachable — try the Render URL instead of Vercel.` };
      }
      setTestResult(data);
      if (data.success) {
        setFeedback({ type: 'success', message: 'API connection tested successfully!' });
        if (config) {
          setConfig({ ...config, status: 'Connected' });
        }
      } else {
        setFeedback({ type: 'error', message: `API connection test failed: ${data.error || 'Unknown status'}` });
        if (config) {
          setConfig({ ...config, status: data.status || 'Invalid' });
        }
      }
    } catch (err: any) {
      setTestResult({ success: false, status: 'Offline', error: err.message });
      setFeedback({ type: 'error', message: `API Connection test error: ${err.message}` });
    } finally {
      setIsTesting(false);
    }
  };

  const handleSaveChanges = async (updatedFields: Partial<AIConfigurationState>) => {
    setIsSaving(true);
    try {
      // If updating api key and it is not changed (meaning user left the masked key), don't send masked key
      const bodyToSave = { ...updatedFields };
      if (bodyToSave.openRouterApiKey && bodyToSave.openRouterApiKey.includes('*')) {
        delete bodyToSave.openRouterApiKey;
      }

      const res = await fetch('/api/ai-config/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(bodyToSave)
      });
      const data = await res.json();
      if (data.success) {
        setConfig(data.config);
        setNewApiKey(data.config.openRouterApiKey);
        setFeedback({ type: 'success', message: 'AI configuration changes saved and applied dynamically!' });
      } else {
        setFeedback({ type: 'error', message: data.error || 'Failed to save configuration' });
      }
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Error saving configuration' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleRollback = async (index: number) => {
    if (!window.confirm('Are you sure you want to rollback to this previous API key?')) return;
    setIsRollingBack(index);
    try {
      const res = await fetch('/api/ai-config/rollback', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ index })
      });
      const data = await res.json();
      if (data.success) {
        setConfig(data.config);
        setNewApiKey(data.config.openRouterApiKey);
        setFeedback({ type: 'success', message: 'Rollback applied successfully!' });
      } else {
        setFeedback({ type: 'error', message: data.error || 'Failed to rollback API key' });
      }
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Error rolling back API key' });
    } finally {
      setIsRollingBack(null);
    }
  };

  const getStatusBadge = (status: AIConfigurationState['status']) => {
    switch (status) {
      case 'Connected':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
            <CheckCircle2 className="w-3.5 h-3.5" />
            Connected
          </span>
        );
      case 'Invalid':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/30">
            <XCircle className="w-3.5 h-3.5" />
            Invalid Key
          </span>
        );
      case 'Rate Limited':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/30">
            <AlertTriangle className="w-3.5 h-3.5" />
            Rate Limited
          </span>
        );
      case 'Offline':
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-slate-500/10 text-slate-400 border border-slate-500/30">
            <AlertCircle className="w-3.5 h-3.5" />
            Offline
          </span>
        );
    }
  };

  if (!config) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center py-20">
        <Loader2 className="w-8 h-8 text-indigo-500 animate-spin mb-4" />
        <p className="text-slate-400 font-medium">Loading AI Provider Configuration...</p>
      </div>
    );
  }

  return (
    <div className="flex-1 p-6 space-y-6 max-w-7xl mx-auto w-full">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-indigo-600/10 rounded-xl border border-indigo-500/20">
              <Cpu className="w-6 h-6 text-indigo-400" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-white">AI Provider Dashboard</h1>
          </div>
          <p className="text-slate-400 mt-1.5 text-sm">
            Centralized controller for LLM integrations, voice synthesis, API keys, and model defaults.
          </p>
        </div>

        {/* Global Toggle */}
        <div className="flex items-center gap-4 bg-slate-900 border border-slate-800 rounded-2xl px-5 py-3 shrink-0">
          <div className="flex flex-col">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Global AI State</span>
            <span className="text-xs font-mono text-indigo-300 mt-0.5">
              {config.aiEnabled ? 'Features Active' : 'Features Disabled'}
            </span>
          </div>
          <button
            onClick={() => handleSaveChanges({ aiEnabled: !config.aiEnabled })}
            className={`w-12 h-6 rounded-full p-1 transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 relative ${
              config.aiEnabled ? 'bg-indigo-600' : 'bg-slate-700'
            }`}
          >
            <span
              className={`block w-4 h-4 rounded-full bg-white shadow transform transition-transform duration-200 ${
                config.aiEnabled ? 'translate-x-6' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
      </div>

      {/* Notification Toast/Bar */}
      <AnimatePresence>
        {feedback && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className={`p-4 rounded-xl border flex items-start gap-3 shadow-md ${
              feedback.type === 'success' 
                ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20' 
                : 'bg-rose-500/10 text-rose-300 border-rose-500/20'
            }`}
          >
            {feedback.type === 'success' ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
            ) : (
              <XCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
            )}
            <div className="flex-1">
              <p className="text-sm font-semibold">{feedback.type === 'success' ? 'Success' : 'Error'}</p>
              <p className="text-xs mt-0.5 opacity-90">{feedback.message}</p>
            </div>
            <button 
              onClick={() => setFeedback(null)} 
              className="text-xs hover:underline uppercase tracking-wider opacity-60 hover:opacity-100 font-bold"
            >
              Dismiss
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column: Key configuration & test */}
        <div className="lg:col-span-2 space-y-6">
          {/* Main config card */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-sm space-y-5">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
              <div className="flex items-center gap-2">
                <Key className="w-5 h-5 text-indigo-400" />
                <h2 className="text-lg font-bold text-white">Central AI Configuration</h2>
              </div>
              {getStatusBadge(config.status)}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {/* Provider Selection */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold uppercase tracking-wider text-slate-400">Default AI Provider</label>
                <select
                  value={config.defaultProvider}
                  onChange={(e) => handleSaveChanges({ defaultProvider: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 hover:border-slate-700 text-slate-100 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/40 transition duration-200"
                >
                  <option value="openrouter">OpenRouter API (Default)</option>
                  <option value="cohere">Cohere API (Trial)</option>
                  <option value="google_studio">Google AI Studio (Gemini SDK)</option>
                </select>
                <p className="text-[10px] text-slate-500">
                  Global fallback routing and system intelligence engine selector.
                </p>
              </div>

              {/* Default Model */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold uppercase tracking-wider text-slate-400">Default AI Model</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={config.defaultModel}
                    onChange={(e) => setConfig({ ...config, defaultModel: e.target.value })}
                    placeholder="Enter model path (e.g. google/gemma-2-9b-it:free)"
                    className="flex-1 bg-slate-950 border border-slate-800 text-slate-100 rounded-xl px-4 py-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/40 transition duration-200"
                  />
                  <button
                    onClick={() => handleSaveChanges({ defaultModel: config.defaultModel })}
                    className="px-4 bg-indigo-600 hover:bg-indigo-500 active:scale-95 text-white text-xs font-semibold rounded-xl transition duration-200 shrink-0"
                  >
                    Apply
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {POPULAR_MODELS.map((m) => (
                    <button
                      key={m.value}
                      onClick={() => {
                        setConfig({ ...config, defaultModel: m.value });
                        handleSaveChanges({ defaultModel: m.value });
                      }}
                      className={`text-[10px] px-2 py-1 rounded-md border font-medium transition duration-200 ${
                        config.defaultModel === m.value
                          ? 'bg-indigo-600/20 text-indigo-300 border-indigo-500/40'
                          : 'bg-slate-950 text-slate-400 border-slate-800 hover:border-slate-700 hover:text-slate-300'
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* API Key Input */}
            <div className="space-y-2 pt-3 border-t border-slate-800/60">
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold uppercase tracking-wider text-slate-400">OpenRouter API Key</label>
                <span className="text-[10px] text-indigo-400 font-medium">Masked automatically in UI</span>
              </div>
              <div className="flex gap-2 relative">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={newApiKey}
                  onChange={(e) => setNewApiKey(e.target.value)}
                  placeholder="Paste OpenRouter API Key (sk-or-v1-...)"
                  className="w-full bg-slate-950 border border-slate-800 text-slate-100 rounded-xl pl-4 pr-12 py-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/40 transition duration-200"
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 transition"
                >
                  {showKey ? <EyeOff className="w-4.5 h-4.5" /> : <Eye className="w-4.5 h-4.5" />}
                </button>
              </div>
              <p className="text-[11px] text-slate-500 leading-normal">
                Primary key (Cohere trial or OpenRouter sk-or-v1-...). All keys tried in priority order; encrypted on saving.
              </p>
            </div>

            {/* Action buttons */}
            <div className="flex flex-wrap items-center gap-3 pt-2">
              <button
                onClick={handleTestConnection}
                disabled={isTesting || !newApiKey}
                className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-indigo-300 hover:text-white bg-indigo-600/10 hover:bg-indigo-600/20 disabled:opacity-50 disabled:pointer-events-none rounded-xl border border-indigo-500/30 transition duration-200"
              >
                {isTesting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />
                    Testing API Connection...
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-4 h-4 text-indigo-400" />
                    Test API Connection
                  </>
                )}
              </button>

              <button
                onClick={() => handleSaveChanges({ openRouterApiKey: newApiKey })}
                disabled={isSaving || !newApiKey || newApiKey === config.openRouterApiKey}
                className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:pointer-events-none rounded-xl shadow-md transition duration-200 ml-auto"
              >
                {isSaving ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4" />
                    Save & Update Key
                  </>
                )}
              </button>
            </div>

            {/* Test Connection Result Log */}
            {testResult && (
              <div className={`p-4 rounded-xl border text-xs font-mono space-y-1 ${
                testResult.success
                  ? 'bg-emerald-500/5 border-emerald-500/20 text-emerald-300'
                  : 'bg-rose-500/5 border-rose-500/20 text-rose-300'
              }`}>
                <div className="flex items-center justify-between">
                  <span className="font-bold">CONNECTION TEST LOG:</span>
                  <span className="font-semibold uppercase px-1.5 py-0.5 rounded text-[9px] bg-slate-900 border border-slate-800">
                    {testResult.status}
                  </span>
                </div>
                {testResult.success ? (
                  <p className="mt-1">✓ Connection successful! OpenRouter.ai responded with HTTP 200.</p>
                ) : (
                  <p className="mt-1">✗ Failed: {testResult.error || 'Check network connection and key authenticity.'}</p>
                )}
              </div>
            )}
          </div>

          {/* Quick instructions / guidelines card */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-sm space-y-4">
            <h3 className="text-sm font-bold uppercase tracking-wider text-slate-300">Supported Commands Info</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-slate-400">
              <div className="bg-slate-950 rounded-xl p-4 border border-slate-800/80 space-y-1.5">
                <span className="font-bold text-white text-sm">#shipu &lt;prompt&gt;</span>
                <p>
                  Centralized system assistant command. Seamlessly accesses OpenRouter using the configured API model dynamically. Supports real-time text response.
                </p>
              </div>
              <div className="bg-slate-950 rounded-xl p-4 border border-slate-800/80 space-y-1.5">
                <span className="font-bold text-white text-sm">#say &lt;message&gt;</span>
                <p>
                  High quality speech synthesis model (Fish Audio). Converts text to high fidelity voice/audio clips, handling long sentences and Bengali/English naturally.
                </p>
              </div>
                </div>
                {config.lastWorkingModel ? (
                  <p className="text-[11px] text-emerald-400 mt-2">
                    ✓ Last working model (auto-used first): <code className="font-mono">{config.lastWorkingModel}</code>
                  </p>
                ) : (
                  <p className="text-[11px] text-slate-500 mt-2">
                    No successful generation yet — the fallback chain tries all {POPULAR_MODELS.length} free models in order.
                  </p>
                )}
              </div>
            </div>

        {/* Right column: Status logs, History & Rollbacks */}
        <div className="space-y-6">
          {/* Logging status indicators */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-sm space-y-4">
            <div className="flex items-center gap-2 border-b border-slate-800 pb-3">
              <TrendingUp className="w-5 h-5 text-indigo-400" />
              <h3 className="text-sm font-bold text-white uppercase tracking-wider">Operational Metrics</h3>
            </div>

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-400 font-medium">Last Request Status:</span>
                <span className="text-xs font-mono font-bold text-slate-200">
                  {config.status === 'Connected' ? 'Healthy' : 'Degraded'}
                </span>
              </div>

              <div className="space-y-1">
                <span className="text-xs text-slate-400 font-medium block">Last Successful Connection:</span>
                <span className="text-xs font-mono text-indigo-300 bg-slate-950 border border-slate-800 px-2 py-1 rounded-md block">
                  {config.lastSuccessfulRequestTime 
                    ? new Date(config.lastSuccessfulRequestTime).toLocaleString() 
                    : 'N/A (No requests logged)'}
                </span>
              </div>

              <div className="space-y-1">
                <span className="text-xs text-slate-400 font-medium block">Last Logged Connection Error:</span>
                <div className="text-xs font-mono text-rose-400 bg-rose-500/5 border border-rose-500/10 p-2.5 rounded-lg max-h-32 overflow-y-auto leading-normal">
                  {config.lastError || 'None (System functioning perfectly)'}
                </div>
              </div>
            </div>
          </div>

          {/* Key History / Rollback Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-sm space-y-4">
            <div className="flex items-center gap-2 border-b border-slate-800 pb-3">
              <History className="w-5 h-5 text-indigo-400" />
              <h3 className="text-sm font-bold text-white uppercase tracking-wider">Previous Key History</h3>
            </div>

            {(!config.keyHistory || config.keyHistory.length === 0) ? (
              <p className="text-xs text-slate-500 italic py-4 text-center">
                No previous keys stored. History automatically populates upon changing the API key.
              </p>
            ) : (
              <div className="space-y-3 max-h-80 overflow-y-auto pr-1">
                {config.keyHistory.map((historyItem, idx) => (
                  <div 
                    key={idx}
                    className="bg-slate-950 border border-slate-800 p-3 rounded-xl flex flex-col gap-2 hover:border-slate-700 transition"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-slate-400 font-mono">
                        {new Date(historyItem.timestamp).toLocaleString()}
                      </span>
                      <span className="text-[9px] font-bold text-indigo-400 uppercase bg-indigo-600/10 px-1.5 py-0.5 rounded border border-indigo-500/20">
                        History #{idx + 1}
                      </span>
                    </div>

                    <div className="text-xs font-mono text-slate-300 truncate bg-slate-900 px-2 py-1.5 rounded border border-slate-850 select-all">
                      {historyItem.key}
                    </div>

                    <button
                      onClick={() => handleRollback(idx)}
                      disabled={isRollingBack !== null}
                      className="w-full mt-1 bg-indigo-600/10 hover:bg-indigo-600 hover:text-white text-indigo-300 disabled:opacity-50 text-xs font-bold py-1.5 rounded-lg border border-indigo-500/20 hover:border-transparent transition duration-200"
                    >
                      {isRollingBack === idx ? (
                        <span className="inline-flex items-center gap-1">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          Restoring...
                        </span>
                      ) : (
                        'Rollback / Restore Key'
                      )}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
