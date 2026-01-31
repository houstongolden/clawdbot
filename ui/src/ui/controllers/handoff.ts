/**
 * Handoff Controller
 * 
 * Handles session sync and handoff to cloud functionality.
 */

import type { AppViewState } from "../app-view-state.js";

const API_BASE = "";

interface SyncResponse {
  success: boolean;
  snapshotId?: string;
  error?: string;
}

interface HandoffResponse {
  success: boolean;
  message: string;
  error?: string;
}

/**
 * Sync current session to cloud
 */
export async function syncSession(state: AppViewState): Promise<boolean> {
  try {
    // Mark as syncing
    (state as any).sessionSyncing = true;
    
    const response = await fetch(`${API_BASE}/api/session/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sessionKey: state.sessionKey,
      }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Sync failed: ${response.status}`);
    }

    const data: SyncResponse = await response.json();
    
    if (!data.success) {
      throw new Error(data.error || "Sync failed");
    }

    // Update last sync time
    (state as any).lastSessionSyncAt = new Date().toISOString();
    
    console.log("[handoff] Session synced:", data.snapshotId);
    return true;

  } catch (err) {
    console.error("[handoff] Sync error:", err);
    return false;
  } finally {
    (state as any).sessionSyncing = false;
  }
}

/**
 * Hand off session to cloud (manual trigger before closing laptop)
 */
export async function handoffToCloud(state: AppViewState): Promise<void> {
  try {
    (state as any).sessionSyncing = true;

    // First, sync the session
    const synced = await syncSession(state);
    if (!synced) {
      alert("Failed to sync session. Please try again.");
      return;
    }

    // Then mark for handoff
    const response = await fetch(`${API_BASE}/api/session/handoff`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sessionKey: state.sessionKey,
      }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Handoff failed: ${response.status}`);
    }

    const data: HandoffResponse = await response.json();

    if (!data.success) {
      throw new Error(data.error || "Handoff failed");
    }

    // Show success message
    alert(
      "✅ Session handed off to cloud!\n\n" +
      "You can now safely close your laptop. " +
      "Myo will continue in the cloud and notify you of any important updates.\n\n" +
      "When you open your laptop again, the session will seamlessly resume locally."
    );

    console.log("[handoff] Session handed off successfully");

  } catch (err) {
    console.error("[handoff] Handoff error:", err);
    alert(`Handoff failed: ${err instanceof Error ? err.message : "Unknown error"}`);
  } finally {
    (state as any).sessionSyncing = false;
  }
}

/**
 * Get session sync status
 */
export async function getSessionSyncStatus(): Promise<{
  initialized: boolean;
  gatewayId: string | null;
  syncedSessions: number;
  heartbeatActive: boolean;
}> {
  try {
    const response = await fetch(`${API_BASE}/api/session/status`);
    if (!response.ok) {
      throw new Error(`Status check failed: ${response.status}`);
    }
    return await response.json();
  } catch (err) {
    console.error("[handoff] Status check error:", err);
    return {
      initialized: false,
      gatewayId: null,
      syncedSessions: 0,
      heartbeatActive: false,
    };
  }
}

export default {
  syncSession,
  handoffToCloud,
  getSessionSyncStatus,
};
