import React, { useState, useEffect } from 'react';
import { apiFetch, formatApiDetail } from '../utils_api';
import TopNavLinks from '../components/TopNavLinks';
import usePreselectEntity from '../hooks/usePreselectEntity';
import { EMPTY_AUTH, buildAuthPayload } from './a2aAuthForm';

const A2AConfigurations = () => {
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(false);
  // Deep link from the Events-tab cog (?agent=<a2a id>): scroll to and highlight it.
  const [, highlightedA2A] = usePreselectEntity('agent', !loading && servers.length > 0);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingServer, setEditingServer] = useState(null);
  const [modalError, setModalError] = useState(null);
  const [validatingId, setValidatingId] = useState(null);
  const [skillsModalVisible, setSkillsModalVisible] = useState(false);
  const [selectedServerSkills, setSelectedServerSkills] = useState(null);
  const [extensionsModalVisible, setExtensionsModalVisible] = useState(false);
  const [selectedServerExtensions, setSelectedServerExtensions] = useState(null);
  const [testModalVisible, setTestModalVisible] = useState(false);
  const [testingServer, setTestingServer] = useState(null);
  const [testMessage, setTestMessage] = useState('');
  const [testResponse, setTestResponse] = useState('');
  const [testLoading, setTestLoading] = useState(false);
  const [taskDetailsModalVisible, setTaskDetailsModalVisible] = useState(false);
  const [taskDetails, setTaskDetails] = useState(null);
  const [taskId, setTaskId] = useState('');
  const [refreshingId, setRefreshingId] = useState(null);
  const [discovering, setDiscovering] = useState(false);
  const [autoFilled, setAutoFilled] = useState(() => new Set());
  const [discoveredInfo, setDiscoveredInfo] = useState(null);
  const [useEnvVar, setUseEnvVar] = useState(false);
  // OAuth2 has up to two secrets (client_secret / refresh_token); each gets the same
  // "store directly vs. read from a backend env var" choice as the bearer token.
  const [useClientSecretEnv, setUseClientSecretEnv] = useState(false);
  const [useRefreshTokenEnv, setUseRefreshTokenEnv] = useState(false);

  const [formData, setFormData] = useState({
    name: '',
    endpoint_url: '',
    agent_card_url: '',
    rpc_endpoint: '/a2a',
    auth: { ...EMPTY_AUTH },
    request_timeout_seconds: 60,
    enabled: true,
    long_running: false,
    poll_interval_seconds: 15
  });

  useEffect(() => {
    fetchServers();
  }, []);

  const fetchServers = async () => {
    setLoading(true);
    try {
      const response = await apiFetch('/configurations/a2a/');
      if (!response.ok) {
        throw new Error('Failed to fetch A2A servers');
      }
      const data = await response.json();
      setServers(data);
    } catch (error) {
      alert('Failed to fetch A2A servers: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  // Pull the real FastAPI error out of a failed response so the user sees the
  // actual cause (e.g. "Cannot connect to ...", "Agent card not found ...")
  // instead of a generic "failed". Handles string, {message}, and 422 arrays.
  const parseError = async (response, fallback) => {
    let detail;
    try {
      detail = (await response.json())?.detail;
    } catch {
      // body wasn't JSON
    }
    if (detail == null) return `${fallback} (HTTP ${response.status})`;
    if (Array.isArray(detail)) {
      return detail.map(d => d?.msg || formatApiDetail(d)).join('; ');
    }
    return formatApiDetail(detail);
  };

  const handleCreate = () => {
    setEditingServer(null);
    setModalError(null);
    setAutoFilled(new Set());
    setDiscoveredInfo(null);
    setUseEnvVar(false);
    setUseClientSecretEnv(false);
    setUseRefreshTokenEnv(false);
    setFormData({
      name: '',
      endpoint_url: '',
      agent_card_url: '',
      rpc_endpoint: '/a2a',
      auth: { ...EMPTY_AUTH },
      request_timeout_seconds: 60,
      enabled: true,
      long_running: false,
      poll_interval_seconds: 15
    });
    setModalVisible(true);
  };

  const handleEdit = (server) => {
    setEditingServer(server);
    setModalError(null);
    setAutoFilled(new Set());
    setDiscoveredInfo(null);
    // Show each env-var field if the server was configured that way (env name set, no direct secret).
    const a = server.auth || {};
    setUseEnvVar(!!a.token_env && !a.token);
    setUseClientSecretEnv(!!a.client_secret_env && !a.client_secret);
    setUseRefreshTokenEnv(!!a.refresh_token_env && !a.refresh_token);
    setFormData({
      name: server.name,
      endpoint_url: server.endpoint_url,
      agent_card_url: server.agent_card_url || '',
      rpc_endpoint: server.rpc_endpoint || '/a2a',
      auth: { ...EMPTY_AUTH, ...a },
      request_timeout_seconds: server.request_timeout_seconds,
      enabled: server.enabled,
      long_running: server.long_running || false,
      poll_interval_seconds: server.poll_interval_seconds || 15
    });
    setModalVisible(true);
  };

  const handleDelete = async (serverId) => {
    if (!confirm('Delete this server?')) return;
    try {
      const response = await apiFetch(`/configurations/a2a/${serverId}`, {
        method: 'DELETE'
      });
      if (!response.ok) {
        alert('Failed to delete: ' + await parseError(response, 'Delete failed'));
        return;
      }
      fetchServers();
    } catch (error) {
      alert('Failed to delete: ' + (error.message || 'Network error'));
    }
  };

  const handleValidate = async (serverId) => {
    setValidatingId(serverId);
    try {
      const response = await apiFetch(`/configurations/a2a/${serverId}/validate`, {
        method: 'POST'
      });
      if (!response.ok) {
        alert('Validation failed: ' + await parseError(response, 'Validation failed'));
        return;
      }
      const data = await response.json();
      alert(`Validated! ${data.skills_count} skills found`);
      fetchServers();
    } catch (error) {
      alert('Validation failed: ' + (error.message || 'Network error'));
    } finally {
      setValidatingId(null);
    }
  };

  const handleRefreshCache = async (serverId) => {
    setRefreshingId(serverId);
    try {
      const response = await apiFetch(`/configurations/a2a/${serverId}/refresh-cache`, {
        method: 'POST'
      });
      if (!response.ok) {
        alert('Failed to refresh cache: ' + await parseError(response, 'Refresh failed'));
        return;
      }
      const data = await response.json();
      alert(`Cache refreshed! ${data.skills_count} skills found`);
      fetchServers();
    } catch (error) {
      alert('Failed to refresh cache: ' + (error.message || 'Network error'));
    } finally {
      setRefreshingId(null);
    }
  };

  const handleShowSkills = (server) => {
    setSelectedServerSkills({
      name: server.name,
      skills: server.cached_agent_card_summary?.skills || [],
      defaultInputModes: server.cached_agent_card_summary?.defaultInputModes || [],
      defaultOutputModes: server.cached_agent_card_summary?.defaultOutputModes || []
    });
    setSkillsModalVisible(true);
  };

  const handleShowExtensions = (server) => {
    // Capabilities (incl. extensions[]) ride along in the cached summary, so the
    // list response already has everything — no extra fetch of the full card.
    // Guard the type: the card is fetched from an external agent and a malformed
    // one could send a non-array here, which would crash the modal's .map.
    const exts = server.cached_agent_card_summary?.capabilities?.extensions;
    setSelectedServerExtensions({
      name: server.name,
      extensions: Array.isArray(exts) ? exts : []
    });
    setExtensionsModalVisible(true);
  };

  const handleTestServer = (server) => {
    setTestingServer(server);
    setTestMessage('');
    setTestResponse('');
    setTestModalVisible(true);
  };

  const handleSendTestMessage = async () => {
    if (!testMessage.trim()) {
      alert('Please enter a message');
      return;
    }

    setTestLoading(true);
    setTestResponse('');

    try {
      const token = localStorage.getItem('access_token') || localStorage.getItem('token');
      const response = await fetch(`/api/configurations/a2a/${testingServer._id}/send-message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token && { 'Authorization': `Bearer ${token}` }),
        },
        body: JSON.stringify({
          message: testMessage,
          context_id: `test_${Date.now()}`
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let result = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.trim()) {
            try {
              const data = JSON.parse(line);
              result += JSON.stringify(data, null, 2) + '\n\n';
              setTestResponse(result);
            } catch (e) {
              result += line + '\n';
              setTestResponse(result);
            }
          }
        }
      }
    } catch (error) {
      setTestResponse(`Error: ${error.message}`);
    } finally {
      setTestLoading(false);
    }
  };

  const handleGetTask = async (serverId) => {
    const inputTaskId = prompt('Enter Task ID:');
    if (!inputTaskId) return;

    try {
      const response = await apiFetch(`/configurations/a2a/${serverId}/tasks/${inputTaskId}`);
      if (!response.ok) {
        throw new Error('Failed to get task');
      }
      const data = await response.json();
      setTaskDetails(data);
      setTaskId(inputTaskId);
      setTaskDetailsModalVisible(true);
    } catch (error) {
      alert('Failed to get task: ' + error.message);
    }
  };

  const handleCancelTask = async (serverId) => {
    const inputTaskId = prompt('Enter Task ID to cancel:');
    if (!inputTaskId) return;

    if (!confirm(`Cancel task ${inputTaskId}?`)) return;

    try {
      const response = await apiFetch(`/configurations/a2a/${serverId}/tasks/${inputTaskId}/cancel`, {
        method: 'POST'
      });
      if (!response.ok) {
        throw new Error('Cancel failed');
      }
      const data = await response.json();
      alert(`Task cancelled! Status: ${data.status?.state || 'Unknown'}`);
    } catch (error) {
      alert('Failed to cancel task: ' + error.message);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setModalError(null);
    try {
      let submitData = {
        name: formData.name,
        endpoint_url: formData.endpoint_url,
        auth: buildAuthPayload(formData.auth, {
          envModes: { token: useEnvVar, client_secret: useClientSecretEnv, refresh_token: useRefreshTokenEnv },
        }),
        request_timeout_seconds: formData.request_timeout_seconds,
        enabled: formData.enabled,
        rpc_endpoint: formData.rpc_endpoint || '/a2a',
        long_running: formData.long_running,
        poll_interval_seconds: formData.poll_interval_seconds
      };

      if (formData.agent_card_url && formData.agent_card_url.trim() !== '') {
        submitData.agent_card_url = formData.agent_card_url;
      }

      const response = await apiFetch(
        editingServer ? `/configurations/a2a/${editingServer._id}` : '/configurations/a2a/',
        {
          method: editingServer ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(submitData)
        }
      );
      if (!response.ok) {
        // Create/update validates by fetching the agent card, so the backend
        // detail is the real reason (unreachable host, 404 card, bad schema…).
        setModalError(await parseError(response, editingServer ? 'Update failed' : 'Create failed'));
        return;
      }
      setModalVisible(false);
      fetchServers();
    } catch (error) {
      setModalError(error.message || 'Network error');
    }
  };

  // Probe the endpoint, validate its agent card, and auto-fill fields from it
  // (without saving). Resolves the card against the origin, so it works even if
  // the endpoint still has a path — the suggested endpoint then corrects it.
  const handleDiscover = async () => {
    if (!formData.endpoint_url || formData.endpoint_url.trim() === '') {
      setModalError('Enter an Endpoint URL first, then click Discover.');
      return;
    }
    setDiscovering(true);
    setModalError(null);
    try {
      const body = {
        // Discover hits the stateless /preview, which authenticates as-is and does NOT
        // restore masked secrets — so drop them here rather than send the "***" placeholder
        // as a credential. (Re-enter the secret to discover with auth on an existing server.)
        endpoint_url: formData.endpoint_url,
        auth: buildAuthPayload(formData.auth, {
          dropMaskedSecrets: true,
          envModes: { token: useEnvVar, client_secret: useClientSecretEnv, refresh_token: useRefreshTokenEnv },
        }),
        request_timeout_seconds: formData.request_timeout_seconds,
      };
      if (formData.agent_card_url && formData.agent_card_url.trim() !== '') {
        body.agent_card_url = formData.agent_card_url;
      }

      const response = await apiFetch('/configurations/a2a/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        setModalError(await parseError(response, 'Discovery failed'));
        return;
      }

      const data = await response.json();
      const s = data.suggested || {};
      const filled = new Set();
      setFormData(prev => {
        const next = { ...prev };
        if (s.endpoint_url) { next.endpoint_url = s.endpoint_url; filled.add('endpoint_url'); }
        if (s.rpc_endpoint) { next.rpc_endpoint = s.rpc_endpoint; filled.add('rpc_endpoint'); }
        if (s.agent_card_url) { next.agent_card_url = s.agent_card_url; filled.add('agent_card_url'); }
        // Fill the name from the card when it's empty or was itself auto-filled
        // (re-Discover refreshes it); preserve a name the user actually typed.
        if (s.name && (!prev.name.trim() || autoFilled.has('name'))) {
          next.name = s.name;
          filled.add('name');
        }
        return next;
      });
      setAutoFilled(filled);

      const cs = data.agent_card_summary || {};
      setDiscoveredInfo({
        name: cs.name,
        version: cs.version,
        protocolVersion: data.protocol_version,
        preferredTransport: data.preferred_transport,
        skills: cs.skills || [],
        defaultInputModes: cs.defaultInputModes || [],
        defaultOutputModes: cs.defaultOutputModes || [],
        discoveredCardUrl: data.discovered_card_url,
      });
    } catch (error) {
      setModalError(error.message || 'Network error');
    } finally {
      setDiscovering(false);
    }
  };

  const handleInputChange = (e) => {
    const { name, value, type, checked } = e.target;
    // Editing a field drops its "auto-filled" badge — the value is now the user's.
    setAutoFilled(prev => {
      if (!prev.has(name)) return prev;
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value
    }));
  };
  const handleAuthChange = (field, value) => {
    setFormData(prev => ({
      ...prev,
      auth: { ...prev.auth, [field]: value }
    }));
  };

  const styles = {
    header: {
      display: 'flex',
      justifyContent: 'space-between',
      marginBottom: '20px'
    },
    infoBox: {
      marginBottom: '20px',
      padding: '10px',
      background: '#1e293b',
      borderRadius: '4px',
      border: '1px solid #334155'
    },
    table: {
      width: '100%',
      borderCollapse: 'collapse',
      backgroundColor: '#1e293b',
      border: '1px solid #334155'
    },
    th: {
      padding: '12px 8px',
      backgroundColor: '#0f172a',
      color: '#94a3b8',
      borderBottom: '1px solid #334155',
      textAlign: 'left',
      fontWeight: '600'
    },
    td: {
      padding: '12px 8px',
      borderBottom: '1px solid #334155',
      color: '#e2e8f0'
    },
    button: {
      padding: '6px 12px',
      backgroundColor: '#3b82f6',
      color: 'white',
      border: 'none',
      borderRadius: '4px',
      cursor: 'pointer',
      fontSize: '12px'
    },
    buttonDanger: {
      padding: '6px 12px',
      backgroundColor: '#ef4444',
      color: 'white',
      border: 'none',
      borderRadius: '4px',
      cursor: 'pointer',
      fontSize: '12px'
    },
    buttonSecondary: {
      padding: '6px 12px',
      backgroundColor: '#475569',
      color: 'white',
      border: 'none',
      borderRadius: '4px',
      cursor: 'pointer',
      fontSize: '12px'
    },
    buttonSmall: {
      marginLeft: '5px',
      padding: '4px 8px',
      backgroundColor: '#3b82f6',
      color: 'white',
      border: 'none',
      borderRadius: '3px',
      cursor: 'pointer',
      fontSize: '11px'
    },
    modalOverlay: {
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(0,0,0,0.7)',
      zIndex: 1000
    },
    modalContent: {
      background: '#1e293b',
      margin: '50px auto',
      width: '500px',
      padding: '20px',
      maxHeight: '80vh',
      overflow: 'auto',
      borderRadius: '8px',
      border: '1px solid #334155'
    },
    modalHeader: {
      display: 'flex',
      justifyContent: 'space-between',
      marginBottom: '20px',
      color: '#e2e8f0'
    },
    formGroup: {
      marginBottom: '15px'
    },
    label: {
      display: 'block',
      marginBottom: '5px',
      color: '#94a3b8',
      fontSize: '14px'
    },
    input: {
      width: '100%',
      padding: '8px',
      backgroundColor: '#0f172a',
      border: '1px solid #334155',
      borderRadius: '4px',
      color: '#e2e8f0',
      fontSize: '14px'
    },
    select: {
      width: '100%',
      padding: '8px',
      backgroundColor: '#0f172a',
      border: '1px solid #334155',
      borderRadius: '4px',
      color: '#e2e8f0',
      fontSize: '14px'
    },
    textarea: {
      width: '100%',
      padding: '8px',
      backgroundColor: '#0f172a',
      border: '1px solid #334155',
      borderRadius: '4px',
      color: '#e2e8f0',
      fontSize: '14px',
      fontFamily: 'monospace'
    },
    pre: {
      background: '#0f172a',
      padding: '10px',
      borderRadius: '4px',
      overflow: 'auto',
      maxHeight: '300px',
      color: '#e2e8f0',
      border: '1px solid #334155'
    },
    skillTag: {
      display: 'inline-block',
      margin: '2px 5px',
      padding: '2px 6px',
      background: '#334155',
      borderRadius: '3px',
      fontSize: '12px',
      color: '#94a3b8'
    },
    skillItem: {
      marginBottom: '15px',
      borderBottom: '1px solid #334155',
      paddingBottom: '10px'
    },
    buttonGroup: {
      display: 'flex',
      gap: '5px',
      flexWrap: 'wrap'
    },
    checkbox: {
      marginRight: '8px'
    },
    closeButton: {
      fontSize: '20px',
      background: 'none',
      border: 'none',
      color: '#94a3b8',
      cursor: 'pointer'
    }
  };

  // Label that grows a small badge when the field was filled by Discover.
  const fieldLabel = (text, field) => (
    <label style={styles.label}>
      {text}
      {autoFilled.has(field) && (
        <span style={{
          marginLeft: '8px', fontSize: '11px', color: '#34d399',
          background: 'rgba(16,185,129,0.12)', border: '1px solid #059669',
          borderRadius: '4px', padding: '1px 6px', verticalAlign: 'middle'
        }}>
          ✨ from agent card
        </span>
      )}
    </label>
  );

  // A secret input (password) plus the same "Advanced: use a backend env var instead"
  // toggle used for the bearer token, reused for each OAuth2 secret (client_secret / refresh_token).
  const secretWithEnvToggle = ({ label, secretField, envField, useEnv, setUseEnv, envPlaceholder }) => (
    <>
      <div style={styles.formGroup}>
        <label style={styles.label}>{label}{!useEnv ? ' *' : ''}</label>
        <input
          type="password"
          value={formData.auth[secretField] || ''}
          onChange={(e) => handleAuthChange(secretField, e.target.value)}
          required={!useEnv}
          placeholder={editingServer ? 'Leave masked value to keep current' : 'Paste the secret'}
          autoComplete="new-password"
          style={styles.input}
        />
        <div style={{ color: '#64748b', fontSize: '12px', marginTop: '4px' }}>
          Stored in the backend database and masked in responses.{' '}
          <button
            type="button"
            // Just reveal/hide the env-var field — do NOT clear the typed secret. Clearing on
            // toggle destroyed a real value on an accidental there-and-back click; mutual
            // exclusion is enforced at save instead (buildAuthPayload envModes).
            onClick={() => setUseEnv(v => !v)}
            style={{ background: 'none', border: 'none', color: '#60a5fa', cursor: 'pointer', padding: 0, fontSize: '12px', textDecoration: 'underline' }}
          >
            {useEnv ? 'Hide env-var option' : 'Advanced: use a backend env var instead'}
          </button>
        </div>
      </div>
      {useEnv && (
        <div style={styles.formGroup}>
          <label style={styles.label}>Environment Variable Name{!formData.auth[secretField] ? ' *' : ''}</label>
          <input
            type="text"
            value={formData.auth[envField] || ''}
            onChange={(e) => handleAuthChange(envField, e.target.value)}
            placeholder={envPlaceholder}
            style={styles.input}
          />
          <div style={{ color: '#64748b', fontSize: '12px', marginTop: '4px' }}>
            The <strong>name</strong> of a backend env var holding the secret — not the secret
            itself. Used only when the field above is blank; the secret then never touches the database.
          </div>
        </div>
      )}
    </>
  );

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <header className="bg-slate-800 border-b border-slate-700 px-4 py-2 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg font-semibold">AppFactory</span>
          <span className="text-slate-500">/</span>
          <span className="text-sm text-slate-300">A2A Servers</span>
        </div>
        <TopNavLinks />
      </header>

      <main style={{ padding: '20px' }}>
      <div style={styles.header}>
        <h2 style={{ color: '#e2e8f0' }}>A2A Server Registry</h2>
        <button onClick={handleCreate} style={styles.button}>Add A2A Server</button>
      </div>

      <div style={styles.infoBox}>
        <p style={{ color: '#94a3b8' }}>ℹ️ Register external A2A agents once and reference them by ID in workflows</p>
      </div>

      {loading && <div style={{ color: '#94a3b8' }}>Loading...</div>}

      {!loading && (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Status</th>
              <th style={styles.th}>Name</th>
              <th style={styles.th}>Endpoint</th>
              <th style={styles.th}>RPC Path</th>
              <th style={styles.th}>Auth</th>
              <th style={styles.th}>Skills</th>
              <th style={styles.th}>Extensions</th>
              <th style={styles.th}>Last Validated</th>
              <th style={styles.th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {servers.map(server => {
              const extsRaw = server.cached_agent_card_summary?.capabilities?.extensions;
              const extensions = Array.isArray(extsRaw) ? extsRaw : [];
              const requiredExtCount = extensions.filter(e => e?.required).length;
              return (
              <tr
                key={server._id}
                data-preselect={server.id || server._id || undefined}
                style={highlightedA2A && (server.id === highlightedA2A || server._id === highlightedA2A) ? { outline: '2px solid #3b82f6', outlineOffset: '-2px' } : undefined}
              >
                <td style={styles.td}>{server.enabled ? '✅ Active' : '⛔ Disabled'}</td>
                <td style={styles.td}>{server.name}</td>
                <td style={styles.td}>{server.endpoint_url}</td>
                <td style={styles.td}>{server.rpc_endpoint || '/a2a'}</td>
                <td style={styles.td}>{server.auth?.type || 'none'}</td>
                <td style={styles.td}>
                  {server.cached_agent_card_summary?.skills?.length || 0} skill(s)
                  {(server.cached_agent_card_summary?.skills?.length || 0) > 0 && (
                    <button onClick={() => handleShowSkills(server)} style={styles.buttonSmall}>View</button>
                  )}
                </td>
                <td style={styles.td}>
                  {extensions.length === 0 ? (
                    <span style={{ color: '#64748b' }}>—</span>
                  ) : (
                    <>
                      {extensions.length}
                      {requiredExtCount > 0 && (
                        <span style={{ color: '#fbbf24', marginLeft: '4px' }} title={`${requiredExtCount} required`}>
                          ({requiredExtCount} req)
                        </span>
                      )}
                      <button onClick={() => handleShowExtensions(server)} style={styles.buttonSmall}>View</button>
                    </>
                  )}
                </td>
                <td style={styles.td}>
                  {server.last_validated_at ? new Date(server.last_validated_at).toLocaleString() : 'Never'}
                </td>
                <td style={styles.td}>
                  <div style={styles.buttonGroup}>
                    <button onClick={() => handleValidate(server._id)} disabled={validatingId === server._id} style={styles.buttonSecondary}>
                      {validatingId === server._id ? '...' : 'Validate'}
                    </button>
                    <button onClick={() => handleRefreshCache(server._id)} disabled={refreshingId === server._id} style={styles.buttonSecondary}>
                      {refreshingId === server._id ? '...' : 'Refresh'}
                    </button>
                    <button onClick={() => handleTestServer(server)} style={styles.buttonSecondary}>Test</button>
                    <button onClick={() => handleGetTask(server._id)} style={styles.buttonSecondary}>Get Task</button>
                    <button onClick={() => handleCancelTask(server._id)} style={styles.buttonSecondary}>Cancel</button>
                    <button onClick={() => handleEdit(server)} style={styles.buttonSecondary}>Edit</button>
                    <button onClick={() => handleDelete(server._id)} style={styles.buttonDanger}>Delete</button>
                  </div>
                </td>
              </tr>
            );})}
          </tbody>
        </table>
      )}

      {/* Modal Form */}
      {modalVisible && (
        <div style={styles.modalOverlay}>
          <div style={styles.modalContent}>
            <div style={styles.modalHeader}>
              <h3 style={{ margin: 0, color: '#e2e8f0' }}>{editingServer ? 'Edit' : 'Add'} A2A Server</h3>
              <button onClick={() => setModalVisible(false)} style={styles.closeButton}>×</button>
            </div>

            {modalError && (
              <div style={{
                background: 'rgba(220,38,38,0.12)',
                border: '1px solid #b91c1c',
                color: '#fca5a5',
                padding: '10px 12px',
                borderRadius: '6px',
                marginBottom: '16px',
                fontSize: '13px',
                wordBreak: 'break-word'
              }}>
                <strong style={{ color: '#f87171' }}>⚠ Could not save</strong>
                <div style={{ marginTop: '4px' }}>{modalError}</div>
              </div>
            )}

            <form onSubmit={handleSubmit}>
              <div style={styles.formGroup}>
                {fieldLabel('Endpoint URL *', 'endpoint_url')}
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type="url"
                    name="endpoint_url"
                    value={formData.endpoint_url}
                    onChange={handleInputChange}
                    required
                    placeholder="http://host:port — origin only, no path"
                    style={{ ...styles.input, flex: 1 }}
                  />
                  <button
                    type="button"
                    onClick={handleDiscover}
                    disabled={discovering}
                    style={{ ...styles.buttonSecondary, whiteSpace: 'nowrap' }}
                  >
                    {discovering ? 'Discovering…' : '🔍 Discover'}
                  </button>
                </div>
                <div style={{ color: '#64748b', fontSize: '12px', marginTop: '4px' }}>
                  Base/origin of the agent (e.g. <code>http://10.0.1.99:80</code>) — no path.
                  The card is read from <code>{'{origin}/.well-known/agent-card.json'}</code>.
                  Click <strong>Discover</strong> to fetch it and auto-fill the fields below.
                </div>
              </div>

              {discoveredInfo && (
                <div style={{
                  background: 'rgba(16,185,129,0.08)', border: '1px solid #059669',
                  borderRadius: '6px', padding: '10px 12px', marginBottom: '15px',
                  fontSize: '13px'
                }}>
                  <strong style={{ color: '#34d399' }}>✓ Agent card discovered</strong>
                  <div style={{
                    marginTop: '6px', display: 'grid',
                    gridTemplateColumns: 'auto 1fr', gap: '3px 12px', color: '#94a3b8'
                  }}>
                    <span>Name</span><span style={{ color: '#e2e8f0' }}>{discoveredInfo.name}</span>
                    <span>Version</span><span style={{ color: '#e2e8f0' }}>{discoveredInfo.version}</span>
                    <span>Protocol</span>
                    <span style={{ color: '#e2e8f0' }}>
                      A2A {discoveredInfo.protocolVersion || '—'}
                      {discoveredInfo.preferredTransport ? ` · ${discoveredInfo.preferredTransport}` : ''}
                    </span>
                    <span>Skills</span>
                    <span style={{ color: '#e2e8f0' }}>
                      {discoveredInfo.skills.length}
                      {discoveredInfo.skills.length > 0
                        ? ` (${discoveredInfo.skills.map(s => s.name || s.id).join(', ')})`
                        : ''}
                    </span>
                    {discoveredInfo.defaultOutputModes.length > 0 && (
                      <>
                        <span>Output modes</span>
                        <span style={{ color: '#e2e8f0' }}>{discoveredInfo.defaultOutputModes.join(', ')}</span>
                      </>
                    )}
                  </div>
                  <div style={{ marginTop: '6px', fontSize: '11px', color: '#64748b', wordBreak: 'break-all' }}>
                    from {discoveredInfo.discoveredCardUrl}
                  </div>
                </div>
              )}

              <div style={styles.formGroup}>
                {fieldLabel('Name *', 'name')}
                <input
                  type="text"
                  name="name"
                  value={formData.name}
                  onChange={handleInputChange}
                  required
                  placeholder="Auto-filled from the agent card — edit to set your own label"
                  style={styles.input}
                />
              </div>

              <div style={styles.formGroup}>
                {fieldLabel('Agent Card URL (Optional)', 'agent_card_url')}
                <input
                  type="url"
                  name="agent_card_url"
                  value={formData.agent_card_url}
                  onChange={handleInputChange}
                  placeholder="Custom path to agent card"
                  style={styles.input}
                />
                <div style={{ color: '#64748b', fontSize: '12px', marginTop: '4px' }}>
                  If empty, the card is fetched from <code>{'{Endpoint URL}/.well-known/agent-card.json'}</code> when you save.
                </div>
              </div>

              <div style={styles.formGroup}>
                  {fieldLabel('RPC Endpoint Path', 'rpc_endpoint')}
                  <input
                    type="text"
                    name="rpc_endpoint"
                    value={formData.rpc_endpoint}
                    onChange={handleInputChange}
                    placeholder="/a2a"
                    style={styles.input}
                  />
                  <div style={{ color: '#64748b', fontSize: '12px', marginTop: '4px' }}>
                    Path appended to the Endpoint URL for JSON-RPC calls (default <code>/a2a</code>).
                    Discover fills this from the card's advertised <code>url</code>.
                  </div>
              </div>

              <div style={styles.formGroup}>
                <label style={styles.label}>Authentication Type</label>
                <select
                  value={formData.auth.type}
                  onChange={(e) => handleAuthChange('type', e.target.value)}
                  style={styles.select}
                >
                  <option value="none">None</option>
                  <option value="bearer">Bearer Token</option>
                  <option value="api_key">API Key</option>
                  <option value="oauth2">OAuth2 (auto-refreshed token)</option>
                </select>
                <div style={{ color: '#64748b', fontSize: '12px', marginTop: '4px' }}>
                  Use <strong>None</strong> unless the agent requires a token — most public agents (and this one's card) advertise no auth.
                  Pick <strong>OAuth2</strong> for agents behind Keycloak/Auth0/Okta (short-lived tokens the backend fetches and refreshes for you).
                </div>
              </div>

              {(formData.auth.type === 'bearer' || formData.auth.type === 'api_key') && (
                <>
                  <div style={styles.formGroup}>
                    <label style={styles.label}>
                      {formData.auth.type === 'bearer' ? 'Bearer Token' : 'API Key'}{!useEnvVar ? ' *' : ''}
                    </label>
                    <input
                      type="password"
                      value={formData.auth.token || ''}
                      onChange={(e) => handleAuthChange('token', e.target.value)}
                      required={!useEnvVar}
                      placeholder={editingServer ? 'Leave masked value to keep current' : 'Paste the token / key'}
                      autoComplete="new-password"
                      style={styles.input}
                    />
                    <div style={{ color: '#64748b', fontSize: '12px', marginTop: '4px' }}>
                      Stored in the backend database and masked in responses (same as the OpenAI key).{' '}
                      <button
                        type="button"
                        // Reveal/hide the env-var field only; the typed token is preserved and
                        // mutual exclusion happens at save (buildAuthPayload envModes). Mirrors
                        // the OAuth2 secretWithEnvToggle.
                        onClick={() => setUseEnvVar(v => !v)}
                        style={{ background: 'none', border: 'none', color: '#60a5fa', cursor: 'pointer', padding: 0, fontSize: '12px', textDecoration: 'underline' }}
                      >
                        {useEnvVar ? 'Hide env-var option' : 'Advanced: use a backend env var instead'}
                      </button>
                    </div>
                  </div>

                  {useEnvVar && (
                    <div style={styles.formGroup}>
                      <label style={styles.label}>Environment Variable Name{!formData.auth.token ? ' *' : ''}</label>
                      <input
                        type="text"
                        value={formData.auth.token_env || ''}
                        onChange={(e) => handleAuthChange('token_env', e.target.value)}
                        placeholder="e.g. RESTRICTION_AGENT_TOKEN"
                        style={styles.input}
                      />
                      <div style={{ color: '#64748b', fontSize: '12px', marginTop: '4px' }}>
                        The <strong>name</strong> of an env var on the backend holding the secret — not the secret
                        itself. Used only when the token above is blank; the secret then never touches the database.
                      </div>
                    </div>
                  )}

                  {formData.auth.type === 'api_key' && (
                    <div style={styles.formGroup}>
                      <label style={styles.label}>Header Name</label>
                      <input
                        type="text"
                        value={formData.auth.header_name || ''}
                        onChange={(e) => handleAuthChange('header_name', e.target.value)}
                        placeholder="X-API-Key"
                        style={styles.input}
                      />
                      <div style={{ color: '#64748b', fontSize: '12px', marginTop: '4px' }}>
                        HTTP header the API key is sent in (default <code>X-API-Key</code>).
                      </div>
                    </div>
                  )}
                </>
              )}

              {formData.auth.type === 'oauth2' && (
                <>
                  <div style={styles.formGroup}>
                    <label style={styles.label}>Grant Type *</label>
                    <select
                      value={formData.auth.grant_type || 'client_credentials'}
                      onChange={(e) => handleAuthChange('grant_type', e.target.value)}
                      style={styles.select}
                    >
                      <option value="client_credentials">Client Credentials (service account)</option>
                      <option value="refresh_token">Refresh Token (offline token)</option>
                    </select>
                    <div style={{ color: '#64748b', fontSize: '12px', marginTop: '4px' }}>
                      <strong>Client Credentials</strong> for a confidential machine-to-machine client (preferred).
                      <strong> Refresh Token</strong> when you only have a previously-issued offline token.
                    </div>
                  </div>

                  <div style={styles.formGroup}>
                    <label style={styles.label}>Token URL *</label>
                    <input
                      type="url"
                      value={formData.auth.token_url || ''}
                      onChange={(e) => handleAuthChange('token_url', e.target.value)}
                      required
                      placeholder="https://keycloak/realms/IDU/protocol/openid-connect/token"
                      style={styles.input}
                    />
                    <div style={{ color: '#64748b', fontSize: '12px', marginTop: '4px' }}>
                      The OAuth2 token endpoint the backend calls to mint/refresh access tokens.
                    </div>
                  </div>

                  <div style={styles.formGroup}>
                    <label style={styles.label}>Client ID *</label>
                    <input
                      type="text"
                      value={formData.auth.client_id || ''}
                      onChange={(e) => handleAuthChange('client_id', e.target.value)}
                      required
                      placeholder="e.g. IDU-auth-helper"
                      style={styles.input}
                    />
                  </div>

                  {formData.auth.grant_type === 'refresh_token'
                    ? secretWithEnvToggle({
                        label: 'Refresh Token',
                        secretField: 'refresh_token',
                        envField: 'refresh_token_env',
                        useEnv: useRefreshTokenEnv,
                        setUseEnv: setUseRefreshTokenEnv,
                        envPlaceholder: 'e.g. IDU_A2A_REFRESH_TOKEN',
                      })
                    : secretWithEnvToggle({
                        label: 'Client Secret',
                        secretField: 'client_secret',
                        envField: 'client_secret_env',
                        useEnv: useClientSecretEnv,
                        setUseEnv: setUseClientSecretEnv,
                        envPlaceholder: 'e.g. IDU_A2A_CLIENT_SECRET',
                      })}

                  <div style={styles.formGroup}>
                    <label style={styles.label}>Scope</label>
                    <input
                      type="text"
                      value={formData.auth.scope || ''}
                      onChange={(e) => handleAuthChange('scope', e.target.value)}
                      placeholder="openid profile offline_access"
                      style={styles.input}
                    />
                    <div style={{ color: '#64748b', fontSize: '12px', marginTop: '4px' }}>
                      Optional, space-separated. Include <code>offline_access</code> if you need a refresh token.
                    </div>
                  </div>

                  <div style={styles.formGroup}>
                    <label style={styles.label}>Extra Header Name</label>
                    <input
                      type="text"
                      value={formData.auth.header_name || ''}
                      onChange={(e) => handleAuthChange('header_name', e.target.value)}
                      placeholder="e.g. x-litellm-api-key"
                      style={styles.input}
                    />
                    <div style={{ color: '#64748b', fontSize: '12px', marginTop: '4px' }}>
                      Optional. Sent on every request next to the OAuth2 bearer, e.g. the key of a gateway
                      in front of the agent.
                    </div>
                  </div>

                  {formData.auth.header_name && secretWithEnvToggle({
                    label: 'Extra Header Value',
                    secretField: 'token',
                    envField: 'token_env',
                    useEnv: useEnvVar,
                    setUseEnv: setUseEnvVar,
                    envPlaceholder: 'e.g. A2A_GATEWAY_KEY',
                  })}
                </>
              )}

              <div style={styles.formGroup}>
                <label style={styles.label}>Request Timeout (seconds)</label>
                <input
                  type="number"
                  name="request_timeout_seconds"
                  value={formData.request_timeout_seconds}
                  onChange={handleInputChange}
                  min={1}
                  max={300}
                  style={styles.input}
                />
              </div>

              <div style={styles.formGroup}>
                <label style={{ color: '#94a3b8', fontSize: '14px' }}>
                  <input
                    type="checkbox"
                    name="long_running"
                    checked={formData.long_running}
                    onChange={handleInputChange}
                    style={styles.checkbox}
                  />
                  Long-running (submit once, then poll — for multi-hour external tasks)
                </label>
              </div>

              {formData.long_running && (
                <div style={styles.formGroup}>
                  <label style={styles.label}>Poll Interval (seconds)</label>
                  <input
                    type="number"
                    name="poll_interval_seconds"
                    value={formData.poll_interval_seconds}
                    onChange={handleInputChange}
                    min={1}
                    max={3600}
                    style={styles.input}
                  />
                </div>
                          )}

              <div style={styles.formGroup}>
                <label style={{ color: '#94a3b8', fontSize: '14px' }}>
                  <input
                    type="checkbox"
                    name="enabled"
                    checked={formData.enabled}
                    onChange={handleInputChange}
                    style={styles.checkbox}
                  />
                  Enabled
                </label>
              </div>

              <div style={{ marginTop: '20px' }}>
                <button type="button" onClick={() => setModalVisible(false)} style={styles.buttonSecondary}>Cancel</button>
                <button type="submit" style={{ ...styles.button, marginLeft: '10px' }}>{editingServer ? 'Update' : 'Create'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Skills Modal */}
      {skillsModalVisible && selectedServerSkills && (
        <div style={styles.modalOverlay}>
          <div style={{ ...styles.modalContent, width: '500px' }}>
            <div style={styles.modalHeader}>
              <h3 style={{ margin: 0, color: '#e2e8f0' }}>Skills for {selectedServerSkills.name}</h3>
              <button onClick={() => setSkillsModalVisible(false)} style={styles.closeButton}>×</button>
            </div>

            <div style={{ marginBottom: '20px' }}>
              <strong style={{ color: '#94a3b8' }}>Input Modes:</strong>
              <div>
                {selectedServerSkills.defaultInputModes.length === 0 ? (
                  <span style={{ color: '#64748b' }}>None</span>
                ) : (
                  selectedServerSkills.defaultInputModes.map(mode => (
                    <span key={mode} style={styles.skillTag}>{mode}</span>
                  ))
                )}
              </div>
            </div>

            <div style={{ marginBottom: '20px' }}>
              <strong style={{ color: '#94a3b8' }}>Output Modes:</strong>
              <div>
                {selectedServerSkills.defaultOutputModes.length === 0 ? (
                  <span style={{ color: '#64748b' }}>None</span>
                ) : (
                  selectedServerSkills.defaultOutputModes.map(mode => (
                    <span key={mode} style={styles.skillTag}>{mode}</span>
                  ))
                )}
              </div>
            </div>

            <h4 style={{ color: '#e2e8f0' }}>Available Skills</h4>
            {selectedServerSkills.skills.length === 0 ? (
              <p style={{ color: '#64748b' }}>No skills available</p>
            ) : (
              selectedServerSkills.skills.map((skill, idx) => (
                <div key={idx} style={styles.skillItem}>
                  <strong style={{ color: '#e2e8f0' }}>{skill.name}</strong>
                  <div style={{ color: '#64748b', fontSize: '12px' }}>ID: {skill.id}</div>
                  {skill.description && <div style={{ color: '#94a3b8', fontSize: '12px' }}>{skill.description}</div>}
                  {skill.tags && skill.tags.length > 0 && (
                    <div style={{ marginTop: '5px' }}>
                      {skill.tags.map(tag => <span key={tag} style={styles.skillTag}>{tag}</span>)}
                    </div>
                  )}
                  {/* Array.isArray, not just .length: the card is unvalidated external
                      input, so a non-conformant agent can send examples/modes as a bare
                      string — .map on which would crash the modal. */}
                  {Array.isArray(skill.examples) && skill.examples.length > 0 && (
                    <div style={{ marginTop: '6px' }}>
                      <span style={{ color: '#64748b', fontSize: '12px' }}>Example prompts:</span>
                      <ul style={{ margin: '4px 0 0', paddingLeft: '18px', color: '#94a3b8', fontSize: '12px' }}>
                        {skill.examples.map((ex, i) => <li key={i}>{ex}</li>)}
                      </ul>
                    </div>
                  )}
                  {/* Per-skill modes override the agent defaults shown above — only shown when the skill sets them. */}
                  {Array.isArray(skill.inputModes) && skill.inputModes.length > 0 && (
                    <div style={{ marginTop: '6px', fontSize: '12px', color: '#64748b' }}>
                      Input: {skill.inputModes.map(m => <span key={m} style={styles.skillTag}>{m}</span>)}
                    </div>
                  )}
                  {Array.isArray(skill.outputModes) && skill.outputModes.length > 0 && (
                    <div style={{ marginTop: '4px', fontSize: '12px', color: '#64748b' }}>
                      Output: {skill.outputModes.map(m => <span key={m} style={styles.skillTag}>{m}</span>)}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Extensions Modal */}
      {extensionsModalVisible && selectedServerExtensions && (
        <div style={styles.modalOverlay}>
          <div style={{ ...styles.modalContent, width: '600px' }}>
            <div style={styles.modalHeader}>
              <h3 style={{ margin: 0, color: '#e2e8f0' }}>Extensions for {selectedServerExtensions.name}</h3>
              <button onClick={() => setExtensionsModalVisible(false)} style={styles.closeButton}>×</button>
            </div>

            <div style={styles.infoBox}>
              <p style={{ color: '#94a3b8', margin: 0, fontSize: '13px' }}>
                Protocol extensions the agent's card advertises. A <strong>required</strong> extension
                with a parameter schema is auto-satisfied on every message: the backend extracts the
                declared params from the run intent and sends them as data parts.
              </p>
            </div>

            {selectedServerExtensions.extensions.length === 0 ? (
              <p style={{ color: '#64748b' }}>No extensions declared</p>
            ) : (
              selectedServerExtensions.extensions.map((ext, idx) => {
                const props = ext?.params?.properties;
                const propNames = props && typeof props === 'object' ? Object.keys(props) : [];
                const requiredProps = Array.isArray(ext?.params?.required) ? ext.params.required : [];
                return (
                  <div key={idx} style={styles.skillItem}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <code style={{ color: '#e2e8f0', fontSize: '13px', wordBreak: 'break-all' }}>{ext?.uri || '(no uri)'}</code>
                      <span style={{
                        fontSize: '11px', padding: '1px 6px', borderRadius: '4px',
                        ...(ext?.required
                          ? { color: '#fbbf24', background: 'rgba(251,191,36,0.12)', border: '1px solid #b45309' }
                          : { color: '#94a3b8', background: '#334155', border: '1px solid #475569' })
                      }}>
                        {ext?.required ? 'REQUIRED' : 'optional'}
                      </span>
                    </div>
                    {ext?.description && (
                      <div style={{ color: '#94a3b8', fontSize: '12px', marginTop: '4px' }}>{ext.description}</div>
                    )}
                    {propNames.length > 0 && (
                      <div style={{ marginTop: '6px' }}>
                        <span style={{ color: '#64748b', fontSize: '12px', marginRight: '4px' }}>Parameters:</span>
                        {propNames.map(p => (
                          <span key={p} style={styles.skillTag}>
                            {p}{requiredProps.includes(p) ? ' *' : ''}
                          </span>
                        ))}
                      </div>
                    )}
                    {ext?.params && (
                      <details style={{ marginTop: '6px', cursor: 'pointer' }}>
                        <summary style={{ color: '#60a5fa', fontSize: '12px' }}>Parameter schema (JSON)</summary>
                        <pre style={{ ...styles.pre, marginTop: '6px' }}>{JSON.stringify(ext.params, null, 2)}</pre>
                      </details>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* Test Modal */}
      {testModalVisible && testingServer && (
        <div style={styles.modalOverlay}>
          <div style={{ ...styles.modalContent, width: '600px' }}>
            <div style={styles.modalHeader}>
              <h3 style={{ margin: 0, color: '#e2e8f0' }}>Test Server: {testingServer.name}</h3>
              <button onClick={() => setTestModalVisible(false)} style={styles.closeButton}>×</button>
            </div>

            <div>
              <label style={styles.label}>Message:</label>
              <textarea
                value={testMessage}
                onChange={(e) => setTestMessage(e.target.value)}
                rows={3}
                style={styles.textarea}
                placeholder="Enter your message here..."
              />
            </div>

            <div style={{ marginTop: '10px' }}>
              <button onClick={handleSendTestMessage} disabled={testLoading} style={styles.button}>
                {testLoading ? 'Sending...' : 'Send Message'}
              </button>
            </div>

            {testResponse && (
              <div style={{ marginTop: '20px' }}>
                <label style={styles.label}>Response:</label>
                <pre style={styles.pre}>
                  {testResponse}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Task Details Modal */}
      {taskDetailsModalVisible && taskDetails && (
        <div style={styles.modalOverlay}>
          <div style={{ ...styles.modalContent, width: '600px' }}>
            <div style={styles.modalHeader}>
              <h3 style={{ margin: 0, color: '#e2e8f0' }}>Task Details: {taskId}</h3>
              <button onClick={() => setTaskDetailsModalVisible(false)} style={styles.closeButton}>×</button>
            </div>

            <pre style={styles.pre}>
              {JSON.stringify(taskDetails, null, 2)}
            </pre>
          </div>
        </div>
      )}
      </main>
    </div>
  );
};

export default A2AConfigurations;