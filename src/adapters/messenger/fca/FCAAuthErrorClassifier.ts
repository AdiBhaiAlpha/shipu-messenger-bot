export type FCAAuthErrorCategory =
  | 'INVALID_APPSTATE'
  | 'SESSION_EXPIRED'
  | 'CHECKPOINT'
  | 'SECURITY_CHALLENGE'
  | 'TWO_FACTOR_REQUIRED'
  | 'ACCOUNT_RESTRICTED'
  | 'NETWORK_ERROR'
  | 'PROVIDER_ERROR'
  | 'UNKNOWN_AUTH_ERROR';

export interface FCAAuthErrorDetails {
  category: FCAAuthErrorCategory;
  isHardFailure: boolean;
  sanitizedReason: string;
  providerName: string;
  userActionRequired: string;
  rawErrorSummary?: string;
}

export class FCAAuthErrorClassifier {
  public static classify(err: any, providerName: string): FCAAuthErrorDetails {
    if (!err) {
      return {
        category: 'UNKNOWN_AUTH_ERROR',
        isHardFailure: false,
        sanitizedReason: 'Unknown null error object returned from login',
        providerName,
        userActionRequired: 'Check session cookies and network connectivity'
      };
    }

    const errStr = (
      typeof err === 'string'
        ? err
        : err?.error || err?.message || err?.errorSummary || err?.error_description || JSON.stringify(err)
    ).toLowerCase();

    // Checkpoint / Security Action
    if (errStr.includes('checkpoint') || errStr.includes('1357004') || errStr.includes('1348092')) {
      return {
        category: 'CHECKPOINT',
        isHardFailure: true,
        sanitizedReason: 'Facebook security checkpoint triggered. Browser login required.',
        providerName,
        userActionRequired: 'Log into Facebook on your browser, complete the checkpoint verification, and re-export appstate_cookie.json'
      };
    }

    // 2FA
    if (errStr.includes('2fa') || errStr.includes('two-factor') || errStr.includes('two factor') || errStr.includes('1348028')) {
      return {
        category: 'TWO_FACTOR_REQUIRED',
        isHardFailure: true,
        sanitizedReason: 'Two-Factor Authentication required by Facebook account',
        providerName,
        userActionRequired: 'Approve browser login prompt on mobile/desktop, or re-export session cookies with active 2FA approval'
      };
    }

    // Account Restricted / Suspended
    if (
      errStr.includes('restricted') ||
      errStr.includes('disabled') ||
      errStr.includes('suspended') ||
      errStr.includes('locked') ||
      errStr.includes('blocked') ||
      errStr.includes('login_blocked')
    ) {
      return {
        category: 'ACCOUNT_RESTRICTED',
        isHardFailure: true,
        sanitizedReason: 'Facebook account restricted, locked, or login blocked by safety filters',
        providerName,
        userActionRequired: 'Log into Facebook on web browser to review and appeal account restriction status'
      };
    }

    // Security Challenge
    if (errStr.includes('security') || errStr.includes('approval') || errStr.includes('unusual activity')) {
      return {
        category: 'SECURITY_CHALLENGE',
        isHardFailure: true,
        sanitizedReason: 'Unusual activity detected by Facebook security systems',
        providerName,
        userActionRequired: 'Log into Facebook in web browser to clear security prompt and re-export appstate_cookie.json'
      };
    }

    // Invalid AppState / Session Expired
    if (
      errStr.includes('session expired') ||
      errStr.includes('cookie expired') ||
      errStr.includes('log in to facebook') ||
      errStr.includes('not logged in') ||
      errStr.includes('not_logged_in') ||
      errStr.includes('invalid appstate') ||
      errStr.includes('invalid cookie') ||
      errStr.includes('login failed') ||
      errStr.includes('wrong password') ||
      errStr.includes('incorrect password') ||
      errStr.includes('getseqid') ||
      errStr.includes('account_inactive') ||
      errStr.includes('auth_error') ||
      errStr.includes('no sync_sequence_id')
    ) {
      return {
        category: 'SESSION_EXPIRED',
        isHardFailure: true,
        sanitizedReason: 'Session credentials (c_user/xs/datr) expired or revoked by Facebook auth server',
        providerName,
        userActionRequired: 'Export a fresh Cookie-Editor AppState from an active, logged-in Facebook browser session'
      };
    }

    // Network / Transport error
    if (errStr.includes('econnrefused') || errStr.includes('etimedout') || errStr.includes('socket') || errStr.includes('fetch failed')) {
      return {
        category: 'NETWORK_ERROR',
        isHardFailure: false,
        sanitizedReason: 'Network connection timeout or DNS resolution failure connecting to Facebook servers',
        providerName,
        userActionRequired: 'Verify internet connection and outbound access to *.facebook.com'
      };
    }

    // Technical / Provider error
    if (errStr.includes('cannot read property') || errStr.includes('is not a function') || errStr.includes('syntaxerror') || errStr.includes('module_not_found')) {
      return {
        category: 'PROVIDER_ERROR',
        isHardFailure: false,
        sanitizedReason: `Internal package error executing ${providerName}`,
        providerName,
        userActionRequired: 'Fallback to secondary provider or update provider dependency'
      };
    }

    // Default Fallback
    const cleanMsg = (err?.message || err?.error || errStr).slice(0, 150);
    return {
      category: 'UNKNOWN_AUTH_ERROR',
      isHardFailure: true,
      sanitizedReason: `Facebook login rejected: ${cleanMsg}`,
      providerName,
      userActionRequired: 'Export a fresh AppState from active browser session and upload to dashboard'
    };
  }
}
