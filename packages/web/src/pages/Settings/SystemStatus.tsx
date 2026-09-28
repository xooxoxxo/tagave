/**
 * System Status Dashboard
 * Shows health status of PostgreSQL, Redis, Worker, and Disk
 * Auto-refreshes every 30 seconds
 */

import { useEffect, useState } from 'react';
import styles from './SystemStatus.module.css';

interface Service {
  status: 'ok' | 'warning' | 'error' | 'degraded';
  message: string;
  details?: Record<string, any>;
}

interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  services: {
    postgres: Service & { version?: string; response_ms?: number };
    redis: Service & { response_ms?: number };
    worker: Service & { active_jobs?: number; last_heartbeat?: string };
    disk: Service & { available_gb?: number; used_percent?: number };
  };
}

const getStatusIcon = (status: string) => {
  switch (status) {
    case 'ok':
      return '✓';
    case 'warning':
      return '⚠';
    case 'error':
      return '✗';
    case 'degraded':
      return '⚠';
    default:
      return '?';
  }
};

const getStatusColor = (status: string) => {
  switch (status) {
    case 'ok':
      return styles.statusOk;
    case 'warning':
      return styles.statusWarning;
    case 'error':
      return styles.statusError;
    case 'degraded':
      return styles.statusWarning;
    default:
      return '';
  }
};

export function SystemStatus() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchHealth = async () => {
    try {
      const response = await fetch('/api/system/health');
      if (!response.ok) {
        throw new Error('Failed to fetch health status');
      }
      const data = await response.json();
      setHealth(data);
      setLastUpdated(new Date());
      setError(null);
    } catch (err) {
      setError((err as any).message || 'Failed to fetch health status');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchHealth();
    const interval = setInterval(fetchHealth, 30000); // Refresh every 30 seconds
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <h1>System Status</h1>
        </div>
        <p className={styles.loading}>Loading...</p>
      </div>
    );
  }

  if (error || !health) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <h1>System Status</h1>
        </div>
        <div className={styles.errorBox}>
          <p className={styles.errorTitle}>Unable to fetch system status</p>
          <p className={styles.errorMessage}>{error}</p>
          <button className={styles.refreshBtn} onClick={fetchHealth}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  const overallStatus = health.status === 'healthy' ? '✓ Healthy' :
                        health.status === 'degraded' ? '⚠ Degraded' :
                        '✗ Unhealthy';
  const overallStatusClass = health.status === 'healthy' ? styles.statusOk :
                             health.status === 'degraded' ? styles.statusWarning :
                             styles.statusError;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1>System Status</h1>
        <p className={styles.subtitle}>
          Overall: <span className={overallStatusClass}>{overallStatus}</span>
        </p>
      </div>

      <div className={styles.serviceGrid}>
        {/* PostgreSQL */}
        <div className={styles.serviceCard}>
          <div className={styles.serviceHeader}>
            <span className={`${styles.statusIcon} ${getStatusColor(health.services.postgres.status)}`}>
              {getStatusIcon(health.services.postgres.status)}
            </span>
            <h3 className={styles.serviceName}>PostgreSQL</h3>
          </div>
          {health.services.postgres.version && (
            <p className={styles.serviceDetail}>v{health.services.postgres.version}</p>
          )}
          {health.services.postgres.response_ms !== undefined && (
            <p className={styles.serviceDetail}>Response: {health.services.postgres.response_ms}ms</p>
          )}
          <p className={styles.serviceMessage}>{health.services.postgres.message}</p>
        </div>

        {/* Redis */}
        <div className={styles.serviceCard}>
          <div className={styles.serviceHeader}>
            <span className={`${styles.statusIcon} ${getStatusColor(health.services.redis.status)}`}>
              {getStatusIcon(health.services.redis.status)}
            </span>
            <h3 className={styles.serviceName}>Redis</h3>
          </div>
          {health.services.redis.response_ms !== undefined && (
            <p className={styles.serviceDetail}>Response: {health.services.redis.response_ms}ms</p>
          )}
          <p className={styles.serviceMessage}>{health.services.redis.message}</p>
        </div>

        {/* Worker */}
        <div className={styles.serviceCard}>
          <div className={styles.serviceHeader}>
            <span className={`${styles.statusIcon} ${getStatusColor(health.services.worker.status)}`}>
              {getStatusIcon(health.services.worker.status)}
            </span>
            <h3 className={styles.serviceName}>Worker</h3>
          </div>
          {health.services.worker.active_jobs !== undefined && (
            <p className={styles.serviceDetail}>{health.services.worker.active_jobs} active jobs</p>
          )}
          {health.services.worker.last_heartbeat && (
            <p className={styles.serviceDetail}>
              Last heartbeat: {new Date(health.services.worker.last_heartbeat).toLocaleTimeString()}
            </p>
          )}
          <p className={styles.serviceMessage}>{health.services.worker.message}</p>
        </div>

        {/* Disk */}
        <div className={styles.serviceCard}>
          <div className={styles.serviceHeader}>
            <span className={`${styles.statusIcon} ${getStatusColor(health.services.disk.status)}`}>
              {getStatusIcon(health.services.disk.status)}
            </span>
            <h3 className={styles.serviceName}>Disk</h3>
          </div>
          {health.services.disk.available_gb !== undefined && (
            <p className={styles.serviceDetail}>{health.services.disk.available_gb} GB available</p>
          )}
          {health.services.disk.used_percent !== undefined && (
            <p className={styles.serviceDetail}>{health.services.disk.used_percent}% full</p>
          )}
          <p className={styles.serviceMessage}>{health.services.disk.message}</p>
        </div>
      </div>

      <div className={styles.actions}>
        <button className={styles.actionBtn} onClick={fetchHealth}>
          Check Now
        </button>
        <a href="/logs" className={styles.actionBtn}>
          View Logs
        </a>
        <a href="/doctor" className={styles.actionBtn}>
          Run Doctor
        </a>
      </div>

      {lastUpdated && (
        <p className={styles.lastUpdated}>
          Last updated: {lastUpdated.toLocaleTimeString()}
        </p>
      )}
    </div>
  );
}
