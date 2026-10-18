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
  UserCheck
} from 'lucide-react';

interface InboxItem {
  id: string;
  threadID: string;
  name: string;
  isGroup: boolean;
  category: 'inbox' | 'request' | 'spam';
  unreadCount: number;
  lastMessage: {
    body: string;
    senderName: string;
    timestamp: number;
  };
  participantCount?: number;
  accountId: string;
  accountName: string;
}

interface BotAccountMeta {
  accountId: string;
  uid: string;
  displayName: string;
  authType: string;
  status: string;
  botEnabled: boolean;
}

export const BotInboxManager: React.FC = () => {
  const [loading, setLoading] = useState<boolean>(true);
  const [accounts, setAccounts] = useState<BotAccountMeta[]>([]);
  const [items, setItems] = useState<InboxItem[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('all');
  const [activeTab, setActiveTab] = useState<'inbox' | 'requests' | 'spam' | 'groups' | 'direct'>('inbox');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedItem, setSelectedItem] = useState<InboxItem | null>(null);
  const [replyText, setReplyText] = useState<string>('');
  const [actionLoading, setActionLoading] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const fetchInboxData = async () => {
    try {
      const res = await fetch('/api/messenger/inbox/all');
      const data = await res.json();
      if (data.success) {
        setAccounts(data.accounts || []);
        setItems(data.items || []);
        if (data.items && data.items.length > 0 && !selectedItem) {
          setSelectedItem(data.items[0]);
        }
      }
    } catch (e) {
      console.error('Failed to fetch bot inbox data:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchInboxData();
    const iv = setInterval(() => { fetchInboxData(); }, 8000);
    return () => clearInterval(iv);
  }, []);

  const showToast = (type: 'success' | 'error', text: string) => {
    setToastMessage({ type, text });
    setTimeout(() => setToastMessage(null), 4000);
  };

  const handleAction = async (action: string, item: InboxItem) => {
    setActionLoading(true);
    try {
      const res = await fetch('/api/messenger/inbox/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: item.accountId,
          threadID: item.threadID,
          action,
          messageBody: replyText
        })
      });
      const data = await res.json();
      if (data.success) {
        if (action === 'accept_request' || action === 'unspam') {
          // Update item category to inbox
          setItems(prev => prev.map(i => i.id === item.id ? { ...i, category: 'inbox' } : i));
          showToast('success', `Successfully moved "${item.name}" to Inbox.`);
        } else if (action === 'decline_request') {
          setItems(prev => prev.filter(i => i.id !== item.id));
          showToast('success', `Message request declined and removed.`);
          setSelectedItem(null);
        } else if (action === 'send_message') {
          showToast('success', `Reply sent successfully to ${item.name}!`);
          setReplyText('');
        }
      } else {
        showToast('error', data.error || 'Action failed.');
      }
    } catch (e) {
      console.error('Action error:', e);
      showToast('error', 'Network error during action execution.');
    } finally {
      setActionLoading(false);
    }
  };

  // Filter items
  const filteredItems = items.filter(item => {
    if (selectedAccountId !== 'all' && item.accountId !== selectedAccountId) return false;
    
    if (activeTab === 'inbox' && item.category !== 'inbox') return false;
    if (activeTab === 'requests' && item.category !== 'request') return false;
    if (activeTab === 'spam' && item.category !== 'spam') return false;
    if (activeTab === 'groups' && !item.isGroup) return false;
    if (activeTab === 'direct' && item.isGroup) return false;

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        item.name.toLowerCase().includes(q) ||
        item.threadID.toLowerCase().includes(q) ||
        item.lastMessage.body.toLowerCase().includes(q) ||
        item.lastMessage.senderName.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const requestCount = items.filter(i => i.category === 'request' && (selectedAccountId === 'all' || i.accountId === selectedAccountId)).length;
  const spamCount = items.filter(i => i.category === 'spam' && (selectedAccountId === 'all' || i.accountId === selectedAccountId)).length;
  const inboxCount = items.filter(i => i.category === 'inbox' && (selectedAccountId === 'all' || i.accountId === selectedAccountId)).length;
  const groupCount = items.filter(i => i.isGroup && (selectedAccountId === 'all' || i.accountId === selectedAccountId)).length;
  const directCount = items.filter(i => !i.isGroup && (selectedAccountId === 'all' || i.accountId === selectedAccountId)).length;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      
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

      {/* Header */}
      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-xl flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-indigo-600 to-purple-600 flex items-center justify-center text-white shadow-lg shadow-indigo-600/30">
              <Inbox className="w-5 h-5" />
            </div>
            <h2 className="text-xl font-bold text-slate-100">Bot Accounts Inbox & Requests Hub</h2>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Monitor and manage active inbox chats, pending message requests, spam boxes, group chats, and direct messages across all connected bot accounts.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Account Filter Dropdown */}
          <select
            value={selectedAccountId}
            onChange={e => setSelectedAccountId(e.target.value)}
            className="bg-slate-950 border border-slate-800 text-slate-200 text-xs rounded-xl px-3 py-2.5 outline-none focus:border-indigo-500 transition"
          >
            <option value="all">🤖 All Bot Accounts ({accounts.length})</option>
            {accounts.map(acc => (
              <option key={acc.accountId} value={acc.accountId}>
                {acc.displayName} ({acc.status})
              </option>
            ))}
          </select>

          <button
            onClick={fetchInboxData}
            disabled={loading}
            className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-xl border border-slate-700 transition flex items-center gap-2 shadow-sm"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
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
          <span>Inbox Chats</span>
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
          <span>Message Requests</span>
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
          <span>Group Chats</span>
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
      </div>

      {/* Main Grid Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Left Column: Conversations List */}
        <div className="bg-slate-900 border border-slate-800 rounded-3xl p-5 shadow-xl space-y-4 flex flex-col h-[650px]">
          
          {/* Search Bar */}
          <div className="relative">
            <Search className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search chats, senders, IDs..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 text-slate-200 text-xs rounded-xl pl-10 pr-3 py-2.5 outline-none focus:border-indigo-500 transition"
            />
          </div>

          {/* List items */}
          <div className="flex-1 overflow-y-auto space-y-2.5 pr-1">
            {loading ? (
              <div className="py-20 text-center text-slate-400 text-xs">Loading conversations...</div>
            ) : filteredItems.length === 0 ? (
              <div className="py-20 text-center space-y-3">
                <Inbox className="w-10 h-10 text-slate-600 mx-auto" />
                <p className="text-slate-400 text-xs font-medium">No conversations found in this category.</p>
              </div>
            ) : (
              filteredItems.map(item => {
                const isSelected = selectedItem?.id === item.id;
                return (
                  <div
                    key={item.id}
                    onClick={() => setSelectedItem(item)}
                    className={`p-3.5 rounded-2xl border transition cursor-pointer flex items-start gap-3 ${
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
                        <h4 className="font-bold text-slate-100 text-xs truncate">{item.name}</h4>
                        <span className="text-[10px] text-slate-500 shrink-0">
                          {(() => { const ts = Number(item.lastMessage?.timestamp); return Number.isFinite(ts) && ts > 0 ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''; })()}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400 truncate mt-0.5">
                        <span className="text-slate-300 font-medium">{item.lastMessage.senderName}:</span> {item.lastMessage.body}
                      </p>
                      
                      <div className="flex items-center gap-2 mt-2">
                        <span className="px-2 py-0.5 rounded bg-slate-900 text-[9px] text-slate-400 border border-slate-800 font-mono">
                          {item.accountName}
                        </span>
                        {item.category === 'request' && (
                          <span className="px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 text-[9px] font-bold">
                            Request
                          </span>
                        )}
                        {item.category === 'spam' && (
                          <span className="px-2 py-0.5 rounded bg-rose-500/20 text-rose-400 text-[9px] font-bold">
                            Spam
                          </span>
                        )}
                      </div>
                    </div>

                    {item.unreadCount > 0 && (
                      <span className="w-5 h-5 rounded-full bg-indigo-600 text-white font-bold text-[10px] flex items-center justify-center shrink-0">
                        {item.unreadCount}
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right Column: Chat Inspector & Action Panel */}
        <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-xl flex flex-col h-[650px]">
          {selectedItem ? (
            <div className="flex flex-col h-full space-y-4">
              
              {/* Chat Header */}
              <div className="flex items-center justify-between pb-4 border-b border-slate-800">
                <div className="flex items-center space-x-3">
                  <div className={`w-12 h-12 rounded-2xl flex items-center justify-center text-white shadow-lg ${
                    selectedItem.category === 'spam'
                      ? 'bg-rose-600'
                      : selectedItem.category === 'request'
                      ? 'bg-amber-600'
                      : 'bg-indigo-600 shadow-indigo-600/30'
                  }`}>
                    {selectedItem.isGroup ? <Users2 className="w-6 h-6" /> : <MessageSquare className="w-6 h-6" />}
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
                      {selectedItem.name}
                      {selectedItem.category === 'request' && (
                        <span className="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 text-[10px] font-bold">
                          Pending Request
                        </span>
                      )}
                      {selectedItem.category === 'spam' && (
                        <span className="px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-400 text-[10px] font-bold">
                          Spam Filtered
                        </span>
                      )}
                    </h3>
                    <p className="text-xs text-slate-400">
                      Thread ID: <code className="text-indigo-300">{selectedItem.threadID}</code> • Account: <span className="text-slate-200">{selectedItem.accountName}</span>
                    </p>
                  </div>
                </div>

                {/* Quick Action Buttons */}
                <div className="flex items-center gap-2">
                  {selectedItem.category === 'request' && (
                    <>
                      <button
                        onClick={() => handleAction('accept_request', selectedItem)}
                        disabled={actionLoading}
                        className="px-3.5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-xl transition flex items-center gap-1.5 shadow-sm"
                      >
                        <UserCheck className="w-4 h-4" />
                        <span>Accept Request</span>
                      </button>
                      <button
                        onClick={() => handleAction('decline_request', selectedItem)}
                        disabled={actionLoading}
                        className="px-3.5 py-2 bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 border border-rose-500/30 text-xs font-semibold rounded-xl transition flex items-center gap-1.5"
                      >
                        <XCircle className="w-4 h-4" />
                        <span>Decline</span>
                      </button>
                    </>
                  )}

                  {selectedItem.category === 'spam' && (
                    <button
                      onClick={() => handleAction('unspam', selectedItem)}
                      disabled={actionLoading}
                      className="px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl transition flex items-center gap-1.5 shadow-sm"
                    >
                      <ShieldCheck className="w-4 h-4" />
                      <span>Move to Inbox (Unspam)</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Message History Simulation */}
              <div className="flex-1 overflow-y-auto bg-slate-950/60 border border-slate-800 rounded-2xl p-4 space-y-3">
                <div className="text-center py-2">
                  <span className="px-3 py-1 bg-slate-900 border border-slate-800 rounded-full text-[10px] text-slate-400">
                    End-to-end encrypted bot connection • Thread synchronized
                  </span>
                </div>

                {/* Incoming Message */}
                <div className="flex items-start gap-2.5">
                  <div className="w-8 h-8 rounded-full bg-slate-800 text-slate-300 font-bold flex items-center justify-center text-xs">
                    {selectedItem.lastMessage.senderName[0]}
                  </div>
                  <div className="space-y-1 max-w-[80%]">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-slate-300">{selectedItem.lastMessage.senderName}</span>
                      <span className="text-[10px] text-slate-500">
                        {(() => { const ts = Number(selectedItem.lastMessage?.timestamp); return Number.isFinite(ts) && ts > 0 ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''; })()}
                      </span>
                    </div>
                    <div className="p-3 bg-slate-800 text-slate-200 text-xs rounded-2xl rounded-tl-sm border border-slate-700">
                      {selectedItem.lastMessage.body}
                    </div>
                  </div>
                </div>

                {/* Bot automated acknowledgement */}
                <div className="flex items-start gap-2.5 justify-end">
                  <div className="space-y-1 max-w-[80%] text-right">
                    <div className="flex items-center justify-end gap-2">
                      <span className="text-[10px] text-slate-500">Just now</span>
                      <span className="text-xs font-semibold text-indigo-400">ShiPu Ai Bot</span>
                    </div>
                    <div className="p-3 bg-indigo-600 text-white text-xs rounded-2xl rounded-tr-sm shadow-md">
                      👋 Hello! ShiPu Ai bot active on this thread. Type a reply below or run <code className="bg-indigo-700 px-1 py-0.5 rounded font-mono">#help</code> for available commands.
                    </div>
                  </div>
                  <div className="w-8 h-8 rounded-full bg-indigo-600 text-white font-bold flex items-center justify-center text-xs shadow-md">
                    🤖
                  </div>
                </div>
              </div>

              {/* Reply Box */}
              <div className="flex items-center gap-2 pt-2">
                <input
                  type="text"
                  placeholder={`Reply to ${selectedItem.name} as bot...`}
                  value={replyText}
                  onChange={e => setReplyText(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && replyText.trim()) {
                      handleAction('send_message', selectedItem);
                    }
                  }}
                  className="flex-1 bg-slate-950 border border-slate-800 text-slate-200 text-xs rounded-xl px-4 py-3 outline-none focus:border-indigo-500 transition"
                />
                <button
                  onClick={() => handleAction('send_message', selectedItem)}
                  disabled={actionLoading || !replyText.trim()}
                  className="px-5 py-3 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold rounded-xl transition flex items-center gap-2 shadow-lg shadow-indigo-600/30"
                >
                  <Send className="w-4 h-4" />
                  <span>Send</span>
                </button>
              </div>

            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center space-y-3">
              <Bot className="w-12 h-12 text-slate-600" />
              <p className="text-slate-400 text-xs font-medium">Select a conversation from the left list to inspect messages, accept requests, or manage spam.</p>
            </div>
          )}
        </div>

      </div>

    </div>
  );
};
