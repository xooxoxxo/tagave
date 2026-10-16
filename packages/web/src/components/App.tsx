import { useEffect } from 'react';
import { Outlet, useNavigate, useLocation } from '@tanstack/react-router';
import { useMe } from '../hooks';
import { rememberConsentRequest, signInTarget } from '../pages/connectReturn';
import styles from './App.module.css';

export function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const { data: user, isLoading, isError } = useMe();

  useEffect(() => {
    // Handle authentication routing
    if (!isLoading) {
      const isAuthPage = location.pathname === '/login' || location.pathname === '/login/2fa' || location.pathname === '/setup';
      // An invite link works signed out, and tells a signed-in person what to do.
      const isInvitePage = location.pathname.startsWith('/invite/');

      if (isError && !isAuthPage && !isInvitePage) {
        // Not authenticated and not on auth page - redirect to login. A
        // Music Connections consent page comes back after signing in.
        if (location.pathname === '/connect/consent') rememberConsentRequest((location.search as { request?: unknown }).request);
        navigate({ to: '/login' });
      } else if (user && isAuthPage) {
        // Authenticated and on an auth page. The account was just created on
        // /setup: first-run setup continues on /onboarding (music folder,
        // first scan). From /login, the consent page that sent them there, or the dashboard.
        navigate(location.pathname === '/setup' ? { to: '/onboarding' } : signInTarget());
      }
    }
  }, [user, isLoading, isError, location.pathname, location.search, navigate]);

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
