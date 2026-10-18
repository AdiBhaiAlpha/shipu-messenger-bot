import React, { useState, useEffect } from 'react';
import {
  Inbox,
  MessageSquare,
  Users2,
  ShieldAlert,
  CheckCircle2,
  XCircle,
  Send,
  RefreshCw,
  Search,
  Bot,
  ShieldCheck,
  Trash2,
  Filter,
  Clock,
  ArrowUpRight,
  Lock,
  Unlock,
  AlertTriangle,
  Check,
  ChevronRight,
  UserCheck,
  Archive,
  Star,
  Pin,
  Bell,
  BellOff,
  Tag,
  FileText,
  Calendar,
  Sparkles,
  Zap,
  Globe,
  Settings,
  MoreVertical,
  Download,
  Smile,
  Paperclip,
  Image as ImageIcon,
  Mic,
  Activity
} from 'lucide-react';
import { MessengerService, ShiPuThread } from '../lib/MessengerService';
import { ActiveConversationView } from './ActiveConversationView';

interface InboxItem extends ShiPuThread {
  isPinned?: boolean;
  isMuted?: boolean;
  aiActive?: boolean;
  tag?: 'VIP' | 'Customer' | 'Friend' | 'Staff' | 'None';
  notes?: string;
  reminder?: string;
  messages: Array<{
    messageID?: string;
    id?: string;
    senderID?: string;
    senderName: string;
    body: string;
    timestamp: number;
    isBot: boolean;
    attachments?: any[];
  }>;
}

interface BotAccountMeta {
  accountId: string;
  uid: string;
  displayName: string;
  authType: string;
  status: string;
  botEnabled: boolean;
  provider?: string;
  mqttStatus?: string;
}

export const CommunicationCenter: React.FC = () => {
  const [loading, setLoading] = useState<boolean>(true);
  const [accounts, setAccounts] = useState<BotAccountMeta[]>([]);
  const [items, setItems] = useState<InboxItem[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('all');
  const [activeTab, setActiveTab] = useState<'inbox' | 'requests' | 'spam' | 'groups' | 'direct' | 'archived' | 'ai_active'>('inbox');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedItem, setSelectedItem] = useState<InboxItem | null>(null);
  const [actionLoading, setActionLoading] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [rightSidebarTab, setRightSidebarTab] = useState<'chat' | 'crm' | 'ai'>('ai');
  const [crmNoteInput, setCrmNoteInput] = useState<string>('');
  const [crmReminderInput, setCrmReminderInput] = useState<string>('');
  const [diagnostics, setDiagnostics] = useState<any[]>([]);

  const fetchInboxData = async () => {
    setLoading(true);
    try {
      const data = await MessengerService.getAllInboxData();
      if (data.success) {
        setAccounts(data.accounts || []);
        setDiagnostics(data.diagnostics || []);
        const enhancedItems = (data.items || []).map((item: any) => ({
          ...item,
          isPinned: item.isPinned || false,
          isMuted: item.isMuted || false,
          aiActive: item.aiActive !== undefined ? item.aiActive : true,
          tag: item.tag || 'None',
          notes: item.notes || '',
          reminder: item.reminder || '',
          messages: item.messages || [
            {
              id: 'm_1',
              senderName: item.lastMessage?.senderName || 'User',
              body: item.lastMessage?.body || 'Hello bot!',
              timestamp: item.lastMessage?.timestamp || Date.now() - 300000,
              isBot: false
            }
          ]
        }));
        setItems(enhancedItems);
        if (enhancedItems.length > 0 && !selectedItem) {
          setSelectedItem(enhancedItems[0]);
          setCrmNoteInput(enhancedItems[0].notes || '');
          setCrmReminderInput(enhancedItems[0].reminder || '');
          fetchThreadHistory(enhancedItems[0]);
        }
      }
    } catch (e) {
      console.error('Failed to fetch communication center data:', e);
      showToast('error', 'Failed to load bot communication center.');
    } finally {
      setLoading(false);
    }
  };

  const fetchThreadHistory = async (item: InboxItem) => {
    try {
      const data = await MessengerService.getThreadHistory(item.accountId, item.threadID);
      if (data.success && data.messages && data.messages.length > 0) {
        setItems(prev => prev.map(i => i.id === item.id ? { ...i, messages: data.messages } : i));
        setSelectedItem(prev => prev && prev.id === item.id ? { ...prev, messages: data.messages } : prev);
      }
      if (data.diagnostic) {
        setDiagnostics(prev => [...prev, { accountId: item.accountId, accountName: item.accountName, diagnostic: data.diagnostic }]);
      }
    } catch (err) {
      console.error('Failed to fetch thread history:', err);
    }
  };

  useEffect(() => {
    fetchInboxData();
  }, []);

  const showToast = (type: 'success' | 'error', text: string) => {
    setToastMessage({ type, text });
    setTimeout(() => setToastMessage(null), 4000);
  };

  const handleAction = async (action: string, item: InboxItem, extraPayload?: any) => {
    setActionLoading(true);
    try {
      if (action === 'toggle_ai') {
        const updatedItem = { ...item, aiActive: !item.aiActive };
        setItems(prev => prev.map(i => i.id === item.id ? updatedItem : i));
        setSelectedItem(updatedItem);
        showToast('success', `AI autopilot is now ${updatedItem.aiActive ? 'ENABLED ✅' : 'DISABLED 🛑'}`);
      } else if (action === 'toggle_pin') {
        const updatedItem = { ...item, isPinned: !item.isPinned };
        setItems(prev => prev.map(i => i.id === item.id ? updatedItem : i));
        setSelectedItem(updatedItem);
      } else if (action === 'toggle_mute') {
        const updatedItem = { ...item, isMuted: !item.isMuted };
        setItems(prev => prev.map(i => i.id === item.id ? updatedItem : i));
        setSelectedItem(updatedItem);
      } else if (action === 'update_tag') {
        const updatedItem = { ...item, tag: extraPayload };
        setItems(prev => prev.map(i => i.id === item.id ? updatedItem : i));
        setSelectedItem(updatedItem);
        showToast('success', `Conversation tag updated to ${extraPayload}`);
      } else if (action === 'save_crm') {
        const updatedItem = { ...item, notes: crmNoteInput, reminder: crmReminderInput };
        setItems(prev => prev.map(i => i.id === item.id ? updatedItem : i));
        setSelectedItem(updatedItem);
        showToast('success', `CRM notes & reminder saved successfully!`);
      } else {
        const res = await MessengerService.performAction(item.accountId, item.threadID, action, extraPayload);
        if (res.success) {
          if (action === 'accept_request' || action === 'unspam') {
            const updatedItem = { ...item, category: 'inbox' as const };
            setItems(prev => prev.map(i => i.id === item.id ? updatedItem : i));
            setSelectedItem(updatedItem);
            showToast('success', `Moved "${item.name}" to Inbox.`);
          } else if (action === 'decline_request') {
            setItems(prev => prev.filter(i => i.id !== item.id));
            setSelectedItem(null);
            showToast('success', `Message request declined.`);
          }
        } else {
          showToast('error', res.diagnostic?.errorStack || 'Action failed');
        }
      }
    } catch (e: any) {
      console.error('Action error:', e);
      showToast('error', e.message || 'Action failed');
    } finally {
      setActionLoading(false);
    }
  };

  const filteredItems = items.filter(item => {
    if (selectedAccountId !== 'all' && item.accountId !== selectedAccountId) return false;
    
    if (activeTab === 'inbox' && item.category !== 'inbox') return false;
    if (activeTab === 'requests' && item.category !== 'request') return false;
    if (activeTab === 'spam' && item.category !== 'spam') return false;
    if (activeTab === 'archived' && item.category !== 'archived') return false;
    if (activeTab === 'groups' && !item.isGroup) return false;
    if (activeTab === 'direct' && item.isGroup) return false;
    if (activeTab === 'ai_active' && !item.aiActive) return false;

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        item.name.toLowerCase().includes(q) ||
        item.threadID.toLowerCase().includes(q) ||
        item.lastMessage.body.toLowerCase().includes(q) ||
        item.lastMessage.senderName.toLowerCase().includes(q) ||
        item.accountName.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const requestCount = items.filter(i => i.category === 'request' && (selectedAccountId === 'all' || i.accountId === selectedAccountId)).length;
  const spamCount = items.filter(i => i.category === 'spam' && (selectedAccountId === 'all' || i.accountId === selectedAccountId)).length;
  const inboxCount = items.filter(i => i.category === 'inbox' && (selectedAccountId === 'all' || i.accountId === selectedAccountId)).length;
  const groupCount = items.filter(i => i.isGroup && (selectedAccountId === 'all' || i.accountId === selectedAccountId)).length;
  const directCount = items.filter(i => !i.isGroup && (selectedAccountId === 'all' || i.accountId === selectedAccountId)).length;
  const aiActiveCount = items.filter(i => i.aiActive && (selectedAccountId === 'all' || i.accountId === selectedAccountId)).length;

  return (
    <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      
      {/* Toast Notification */}
      {toastMessage && (
        <div className={`fixed top-6 right-6 z-50 px-5 py-3 rounded-2xl shadow-2xl border flex items-center gap-3 animate-in fade-in slide-in-from-top-4 duration-300 ${
          toastMessage.type === 'success'
            ? 'bg-slate-900 border-emerald-500/50 text-emerald-300'
            : 'bg-slate-900 border-rose-500/50 text-rose-300'
        }`}>
          {toastMessage.type === 'success' ? <CheckCircle2 className="w-5 h-5 text-emerald-400" /> : <XCircle className="w-5 h-5 text-rose-400" />}
          <span className="text-xs font-semibold">{toastMessage.text}</span>
        </div>
      )}

      {/* Diagnostics Panel if API issues occurred */}
      {diagnostics.length > 0 && (
        <div className="bg-rose-950/40 border border-rose-500/30 rounded-3xl p-4 shadow-xl space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-rose-300 font-bold text-xs">
              <AlertTriangle className="w-4 h-4 text-rose-400" />
              <span>FCA API Diagnostics ({diagnostics.length} issues reported)</span>
            </div>
            <button
              onClick={() => setDiagnostics([])}
              className="text-[10px] text-rose-400 hover:underline"
            >
              Dismiss
            </button>
          </div>
          <div className="space-y-2 max-h-40 overflow-y-auto pr-1">
            {diagnostics.map((d, idx) => (
              <div key={idx} className="bg-slate-950/80 border border-rose-900/50 rounded-2xl p-3 text-[11px] space-y-1">
                <div className="flex items-center justify-between text-slate-300 font-semibold">
                  <span>Account: {d.accountName} ({d.accountId})</span>
                  <span className="text-rose-400 font-mono">Method: {d.diagnostic?.method}</span>
                </div>
                <p className="text-slate-400 font-mono">Parameters: {JSON.stringify(d.diagnostic?.parameters)}</p>
                <p className="text-rose-300 font-mono truncate">Error: {d.diagnostic?.errorStack}</p>
                <p className="text-emerald-300 font-medium">Suggested Fix: {d.diagnostic?.suggestedFix}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Header & Overview Stats Bar */}
      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-xl flex flex-col lg:flex-row lg:items-center justify-between gap-6">
        <div>
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-indigo-600 via-purple-600 to-pink-600 flex items-center justify-center text-white shadow-lg shadow-indigo-600/30">
              <Globe className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-slate-100">Unified Messenger Communication Center</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Multi-account command hub managing all bot inboxes, message requests, spam boxes, group chats, CRM notes, and AI autopilot in real time.
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Account Filter Dropdown */}
          <div className="flex items-center gap-2 bg-slate-950 border border-slate-800 rounded-2xl px-3 py-2">
            <Bot className="w-4 h-4 text-indigo-400" />
            <select
              value={selectedAccountId}
              onChange={e => setSelectedAccountId(e.target.value)}
              className="bg-transparent text-slate-200 text-xs outline-none cursor-pointer"
            >
              <option value="all">🤖 All Connected Accounts ({accounts.length})</option>
              {accounts.map(acc => (
                <option key={acc.accountId} value={acc.accountId}>
                  {acc.displayName} ({acc.status})
                </option>
              ))}
            </select>
          </div>

          <button
            onClick={fetchInboxData}
            disabled={loading}
            className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-xl border border-slate-700 transition flex items-center gap-2 shadow-sm"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            <span>Sync Hub</span>
          </button>
        </div>
      </div>

      {/* Quick Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex items-center justify-between shadow-md">
          <div>
            <p className="text-[11px] font-medium text-slate-400">Inbox Chats</p>
            <h4 className="text-lg font-bold text-slate-100 mt-0.5">{inboxCount}</h4>
          </div>
          <div className="w-9 h-9 rounded-xl bg-indigo-600/20 text-indigo-400 border border-indigo-500/30 flex items-center justify-center">
            <Inbox className="w-4 h-4" />
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex items-center justify-between shadow-md">
          <div>
            <p className="text-[11px] font-medium text-slate-400">Message Requests</p>
            <h4 className="text-lg font-bold text-amber-400 mt-0.5">{requestCount}</h4>
          </div>
          <div className="w-9 h-9 rounded-xl bg-amber-600/20 text-amber-400 border border-amber-500/30 flex items-center justify-center">
            <Clock className="w-4 h-4" />
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex items-center justify-between shadow-md">
          <div>
            <p className="text-[11px] font-medium text-slate-400">Spam Box</p>
            <h4 className="text-lg font-bold text-rose-400 mt-0.5">{spamCount}</h4>
          </div>
          <div className="w-9 h-9 rounded-xl bg-rose-600/20 text-rose-400 border border-rose-500/30 flex items-center justify-center">
            <ShieldAlert className="w-4 h-4" />
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex items-center justify-between shadow-md">
          <div>
            <p className="text-[11px] font-medium text-slate-400">Group Chats</p>
            <h4 className="text-lg font-bold text-slate-100 mt-0.5">{groupCount}</h4>
          </div>
          <div className="w-9 h-9 rounded-xl bg-purple-600/20 text-purple-400 border border-purple-500/30 flex items-center justify-center">
            <Users2 className="w-4 h-4" />
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex items-center justify-between shadow-md">
          <div>
            <p className="text-[11px] font-medium text-slate-400">Direct Chats</p>
            <h4 className="text-lg font-bold text-slate-100 mt-0.5">{directCount}</h4>
          </div>
          <div className="w-9 h-9 rounded-xl bg-blue-600/20 text-blue-400 border border-blue-500/30 flex items-center justify-center">
            <MessageSquare className="w-4 h-4" />
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex items-center justify-between shadow-md">
          <div>
            <p className="text-[11px] font-medium text-slate-400">AI Autopilot Active</p>
            <h4 className="text-lg font-bold text-emerald-400 mt-0.5">{aiActiveCount}</h4>
          </div>
          <div className="w-9 h-9 rounded-xl bg-emerald-600/20 text-emerald-400 border border-emerald-500/30 flex items-center justify-center">
            <Sparkles className="w-4 h-4" />
          </div>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 pb-3">
        <button
          onClick={() => setActiveTab('inbox')}
          className={`px-4 py-2 rounded-xl text-xs font-semibold transition flex items-center gap-2 ${
            activeTab === 'inbox'
              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
              : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700'
          }`}
        >
          <Inbox className="w-4 h-4" />
          <span>Inbox</span>
          <span className="px-1.5 py-0.5 rounded-full bg-slate-800 text-[10px] text-slate-300 font-bold">{inboxCount}</span>
        </button>

        <button
          onClick={() => setActiveTab('requests')}
          className={`px-4 py-2 rounded-xl text-xs font-semibold transition flex items-center gap-2 ${
            activeTab === 'requests'
              ? 'bg-amber-600 text-white shadow-lg shadow-amber-600/25'
              : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700'
          }`}
        >
          <Clock className="w-4 h-4" />
          <span>Requests</span>
          {requestCount > 0 && (
            <span className="px-1.5 py-0.5 rounded-full bg-amber-500 text-[10px] text-slate-950 font-extrabold">{requestCount}</span>
          )}
        </button>

        <button
          onClick={() => setActiveTab('spam')}
          className={`px-4 py-2 rounded-xl text-xs font-semibold transition flex items-center gap-2 ${
            activeTab === 'spam'
              ? 'bg-rose-600 text-white shadow-lg shadow-rose-600/25'
              : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700'
          }`}
        >
          <ShieldAlert className="w-4 h-4" />
          <span>Spam Box</span>
          {spamCount > 0 && (
            <span className="px-1.5 py-0.5 rounded-full bg-rose-500 text-[10px] text-white font-extrabold">{spamCount}</span>
          )}
        </button>

        <button
          onClick={() => setActiveTab('groups')}
          className={`px-4 py-2 rounded-xl text-xs font-semibold transition flex items-center gap-2 ${
            activeTab === 'groups'
              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
              : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700'
          }`}
        >
          <Users2 className="w-4 h-4" />
          <span>Groups</span>
          <span className="px-1.5 py-0.5 rounded-full bg-slate-800 text-[10px] text-slate-300 font-bold">{groupCount}</span>
        </button>

        <button
          onClick={() => setActiveTab('direct')}
          className={`px-4 py-2 rounded-xl text-xs font-semibold transition flex items-center gap-2 ${
            activeTab === 'direct'
              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
              : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700'
          }`}
        >
          <MessageSquare className="w-4 h-4" />
          <span>Direct Chats</span>
          <span className="px-1.5 py-0.5 rounded-full bg-slate-800 text-[10px] text-slate-300 font-bold">{directCount}</span>
        </button>

        <button
          onClick={() => setActiveTab('ai_active')}
          className={`px-4 py-2 rounded-xl text-xs font-semibold transition flex items-center gap-2 ${
            activeTab === 'ai_active'
              ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/25'
              : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700'
          }`}
        >
          <Sparkles className="w-4 h-4" />
          <span>AI Active</span>
          <span className="px-1.5 py-0.5 rounded-full bg-slate-800 text-[10px] text-slate-300 font-bold">{aiActiveCount}</span>
        </button>
      </div>

      {/* Main 3-Column Communication Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* Left Column: Conversations List (4 cols) */}
        <div className="lg:col-span-4 bg-slate-900 border border-slate-800 rounded-3xl p-4 shadow-xl space-y-3 flex flex-col h-[700px]">
          
          {/* Search Bar */}
          <div className="relative">
            <Search className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search chats, senders, IDs, tags..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 text-slate-200 text-xs rounded-xl pl-10 pr-3 py-2.5 outline-none focus:border-indigo-500 transition"
            />
          </div>

          {/* List items */}
          <div className="flex-1 overflow-y-auto space-y-2 pr-1">
            {loading ? (
              <div className="py-24 text-center text-slate-400 text-xs">Loading conversations...</div>
            ) : filteredItems.length === 0 ? (
              <div className="py-24 text-center space-y-3">
                <Inbox className="w-10 h-10 text-slate-600 mx-auto" />
                <p className="text-slate-400 text-xs font-medium">No conversations found.</p>
              </div>
            ) : (
              filteredItems.map(item => {
                const isSelected = selectedItem?.id === item.id;
                return (
                  <div
                    key={item.id}
                    onClick={() => {
                      setSelectedItem(item);
                      setCrmNoteInput(item.notes || '');
                      setCrmReminderInput(item.reminder || '');
                      fetchThreadHistory(item);
                    }}
                    className={`p-3 rounded-2xl border transition cursor-pointer flex items-start gap-3 ${
                      isSelected
                        ? 'bg-slate-800/90 border-indigo-500 shadow-md shadow-indigo-500/10'
                        : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
                    }`}
                  >
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-white shrink-0 font-bold ${
                      item.category === 'spam'
                        ? 'bg-rose-600/30 text-rose-400 border border-rose-500/30'
                        : item.category === 'request'
                        ? 'bg-amber-600/30 text-amber-400 border border-amber-500/30'
                        : item.isGroup
                        ? 'bg-indigo-600'
                        : 'bg-purple-600'
                    }`}>
                      {item.isGroup ? <Users2 className="w-5 h-5" /> : <MessageSquare className="w-5 h-5" />}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <h4 className="font-bold text-slate-100 text-xs truncate flex items-center gap-1.5">
                          {item.isPinned && <Pin className="w-3 h-3 text-amber-400 fill-amber-400 shrink-0" />}
                          <span className="truncate">{item.name}</span>
                        </h4>
                        <span className="text-[10px] text-slate-500 shrink-0">
                          {(() => { const ts = Number(item.lastMessage?.timestamp); return Number.isFinite(ts) && ts > 0 ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''; })()}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400 truncate mt-0.5">
                        <span className="text-slate-300 font-medium">{item.lastMessage.senderName}:</span> {item.lastMessage.body}
                      </p>
                      
                      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                        <span className="px-2 py-0.5 rounded bg-slate-900 text-[9px] text-slate-400 border border-slate-800 font-mono">
                          {item.accountName}
                        </span>
                        {item.tag && item.tag !== 'None' && (
                          <span className={`px-2 py-0.5 rounded text-[9px] font-bold ${
                            item.tag === 'VIP' ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30' :
                            item.tag === 'Customer' ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30' :
                            item.tag === 'Staff' ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30' :
                            'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                          }`}>
                            {item.tag}
                          </span>
                        )}
                        {item.aiActive && (
                          <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 text-[9px] flex items-center gap-1 font-bold">
                            <Sparkles className="w-2.5 h-2.5" /> AI
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Center Column: Active Chat Inspector & Messaging (5 cols) */}
        <div className="lg:col-span-5 bg-slate-900 border border-slate-800 rounded-3xl p-5 shadow-xl flex flex-col h-[700px]">
          {selectedItem ? (
            <ActiveConversationView
              selectedItem={selectedItem}
              onActionComplete={async (action, updated) => {
                await fetchInboxData();
              }}
              showToast={showToast}
            />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center space-y-3">
              <MessageSquare className="w-12 h-12 text-slate-600" />
              <p className="text-slate-400 text-xs font-medium">Select a conversation to inspect chat history and reply.</p>
            </div>
          )}
        </div>

        {/* Right Column: AI Autopilot & CRM Panel (3 cols) */}
        <div className="lg:col-span-3 bg-slate-900 border border-slate-800 rounded-3xl p-4 shadow-xl flex flex-col h-[700px]">
          {selectedItem ? (
            <div className="flex flex-col h-full space-y-4">
              
              {/* Right Sidebar Header tabs */}
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <button
                  onClick={() => setRightSidebarTab('ai')}
                  className={`flex-1 pb-2 text-xs font-bold transition border-b-2 flex items-center justify-center gap-1.5 ${
                    rightSidebarTab === 'ai' ? 'border-indigo-500 text-indigo-400' : 'border-transparent text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Sparkles className="w-3.5 h-3.5" /> AI Autopilot
                </button>
                <button
                  onClick={() => setRightSidebarTab('crm')}
                  className={`flex-1 pb-2 text-xs font-bold transition border-b-2 flex items-center justify-center gap-1.5 ${
                    rightSidebarTab === 'crm' ? 'border-indigo-500 text-indigo-400' : 'border-transparent text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <FileText className="w-3.5 h-3.5" /> CRM & Tags
                </button>
              </div>

              {rightSidebarTab === 'ai' ? (
                <div className="flex-1 overflow-y-auto space-y-4 pr-1 text-xs">
                  
                  {/* AI Autopilot Toggle Box */}
                  <div className="p-4 bg-slate-950 border border-slate-800 rounded-2xl space-y-3 shadow-sm">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Bot className="w-4 h-4 text-indigo-400" />
                        <span className="font-bold text-slate-200">ShiPu AI Autopilot</span>
                      </div>
                      <button
                        onClick={() => handleAction('toggle_ai', selectedItem)}
                        className={`w-10 h-6 rounded-full transition relative ${selectedItem.aiActive ? 'bg-emerald-600' : 'bg-slate-700'}`}
                      >
                        <div className={`w-4 h-4 rounded-full bg-white absolute top-1 transition-all ${selectedItem.aiActive ? 'right-1' : 'left-1'}`} />
                      </button>
                    </div>
                    <p className="text-[11px] text-slate-400 leading-relaxed">
                      {selectedItem.aiActive
                        ? 'AI is actively analyzing incoming messages in this chat and responding autonomously.'
                        : 'AI autopilot is paused for this chat. Admin manual control active.'}
                    </p>
                  </div>

                  {/* AI Conversation Summary */}
                  <div className="p-4 bg-slate-950 border border-slate-800 rounded-2xl space-y-2">
                    <span className="text-[11px] font-bold text-indigo-400 uppercase tracking-wider flex items-center gap-1.5">
                      <Zap className="w-3.5 h-3.5" /> AI Summary & Intent
                    </span>
                    <p className="text-slate-300 leading-relaxed text-[11px]">
                      User is inquiring about bot configuration, cookie import steps, and command documentation. High intent potential.
                    </p>
                  </div>

                  {/* AI Context Roster */}
                  <div className="p-4 bg-slate-950 border border-slate-800 rounded-2xl space-y-2">
                    <span className="text-[11px] font-bold text-purple-400 uppercase tracking-wider flex items-center gap-1.5">
                      <Activity className="w-3.5 h-3.5" /> Memory & Context Stats
                    </span>
                    <div className="space-y-1.5 text-slate-400 text-[11px]">
                      <div className="flex justify-between">
                        <span>Model:</span>
                        <span className="text-slate-200 font-mono">Gemini 2.5 Flash</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Context Tokens:</span>
                        <span className="text-slate-200 font-mono">1,420 / 8,192</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Stored Memories:</span>
                        <span className="text-emerald-400 font-mono">4 active facts</span>
                      </div>
                    </div>
                  </div>

                </div>
              ) : (
                <div className="flex-1 overflow-y-auto space-y-4 pr-1 text-xs">
                  
                  {/* Tag Selector */}
                  <div className="space-y-2">
                    <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Conversation Tag</label>
                    <div className="grid grid-cols-2 gap-2">
                      {(['VIP', 'Customer', 'Staff', 'Friend', 'None'] as const).map(tagOpt => (
                        <button
                          key={tagOpt}
                          onClick={() => handleAction('update_tag', selectedItem, tagOpt)}
                          className={`py-2 px-3 rounded-xl border text-xs font-semibold transition flex items-center justify-center gap-1.5 ${
                            selectedItem.tag === tagOpt
                              ? 'bg-indigo-600 border-indigo-500 text-white shadow'
                              : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700'
                          }`}
                        >
                          <Tag className="w-3.5 h-3.5" />
                          <span>{tagOpt}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* CRM Notes */}
                  <div className="space-y-2">
                    <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Admin CRM Notes</label>
                    <textarea
                      rows={3}
                      placeholder="Add private notes about this user or group..."
                      value={crmNoteInput}
                      onChange={e => setCrmNoteInput(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 text-slate-200 text-xs rounded-xl p-3 outline-none focus:border-indigo-500 transition resize-none"
                    />
                  </div>

                  {/* Reminder */}
                  <div className="space-y-2">
                    <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Follow-up Reminder</label>
                    <input
                      type="text"
                      placeholder="e.g., Follow up tomorrow at 3 PM"
                      value={crmReminderInput}
                      onChange={e => setCrmReminderInput(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 text-slate-200 text-xs rounded-xl px-3 py-2.5 outline-none focus:border-indigo-500 transition"
                    />
                  </div>

                  <button
                    onClick={() => handleAction('save_crm', selectedItem)}
                    className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl shadow-lg shadow-indigo-600/30 transition"
                  >
                    Save CRM Details
                  </button>

                </div>
              )}

            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center space-y-3">
              <Tag className="w-10 h-10 text-slate-600" />
              <p className="text-slate-400 text-xs font-medium">Select a conversation to view CRM and AI controls.</p>
            </div>
          )}
        </div>

      </div>

    </div>
  );
};
