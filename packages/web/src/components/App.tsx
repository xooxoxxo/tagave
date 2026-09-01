import { useEffect } from 'react';
import { Outlet, useNavigate, useLocation } from '@tanstack/react-router';
import { useMe } from '../hooks';
import styles from './App.module.css';

export function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const { data: user, isLoading, isError } = useMe();

  useEffect(() => {
    // Handle authentication routing
    if (!isLoading) {
      const isAuthPage = location.pathname === '/login' || location.pathname === '/setup';

      if (isError && !isAuthPage) {
        // Not authenticated and not on auth page - redirect to login
        navigate({ to: '/login' });
      } else if (user && isAuthPage) {
        // Authenticated and on auth page - redirect to dashboard
        navigate({ to: '/' });
      }
    }
  }, [user, isLoading, isError, location.pathname, navigate]);

  // Show loading state while checking authentication
  if (isLoading) {
    return (
      <div className={styles.loadingContainer}>
        <div className={styles.spinner} />
        <p>Loading...</p>
      </div>
    );
  }

  return <Outlet />;
}
