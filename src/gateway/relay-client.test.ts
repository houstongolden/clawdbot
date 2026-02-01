/**
 * Tests for Myobot Relay Client
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { MyobotRelayClient, type RelayConfig } from "./relay-client.js";

describe("MyobotRelayClient", () => {
  describe("canStart", () => {
    test("returns false when disabled", () => {
      const client = new MyobotRelayClient({ enabled: false });
      const result = client.canStart();
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("relay disabled in config");
    });

    test("returns false when missing supabaseUrl", () => {
      // Save and clear env vars that might interfere
      const savedEnv = {
        SUPABASE_URL: process.env.SUPABASE_URL,
        MYO_SUPABASE_URL: process.env.MYO_SUPABASE_URL,
      };
      delete process.env.SUPABASE_URL;
      delete process.env.MYO_SUPABASE_URL;

      try {
        const client = new MyobotRelayClient({
          enabled: true,
          supabaseUrl: "",
          supabaseAnonKey: "key",
          userId: "user",
        });
        const result = client.canStart();
        expect(result.ok).toBe(false);
        expect(result.reason).toBe("missing supabaseUrl");
      } finally {
        // Restore env vars
        if (savedEnv.SUPABASE_URL) process.env.SUPABASE_URL = savedEnv.SUPABASE_URL;
        if (savedEnv.MYO_SUPABASE_URL) process.env.MYO_SUPABASE_URL = savedEnv.MYO_SUPABASE_URL;
      }
    });

    test("returns false when missing supabaseAnonKey", () => {
      const client = new MyobotRelayClient({
        enabled: true,
        supabaseUrl: "https://example.supabase.co",
        supabaseAnonKey: "",
        userId: "user",
      });
      const result = client.canStart();
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("missing supabaseAnonKey");
    });

    test("returns false when missing userId", () => {
      const client = new MyobotRelayClient({
        enabled: true,
        supabaseUrl: "https://example.supabase.co",
        supabaseAnonKey: "key",
        userId: "",
      });
      const result = client.canStart();
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("missing userId");
    });

    test("returns true when all required config is present", () => {
      const client = new MyobotRelayClient({
        enabled: true,
        supabaseUrl: "https://example.supabase.co",
        supabaseAnonKey: "key",
        userId: "user-123",
      });
      const result = client.canStart();
      expect(result.ok).toBe(true);
    });
  });

  describe("getGatewayId", () => {
    test("uses provided gatewayId", () => {
      const client = new MyobotRelayClient({
        enabled: true,
        gatewayId: "my-gateway-123",
      });
      expect(client.getGatewayId()).toBe("my-gateway-123");
    });

    test("generates gatewayId if not provided", () => {
      const client = new MyobotRelayClient({ enabled: true });
      const gatewayId = client.getGatewayId();
      expect(gatewayId).toMatch(/^gateway-[a-z0-9]+$/);
    });
  });

  describe("isConnected", () => {
    test("returns false initially", () => {
      const client = new MyobotRelayClient({ enabled: true });
      expect(client.isConnected()).toBe(false);
    });
  });

  describe("config resolution", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    test("falls back to MYO_SUPABASE_URL env var", () => {
      process.env.MYO_SUPABASE_URL = "https://env.supabase.co";
      const client = new MyobotRelayClient({
        enabled: true,
        supabaseAnonKey: "key",
        userId: "user",
      });
      const result = client.canStart();
      expect(result.ok).toBe(true);
    });

    test("falls back to MYO_USER_ID env var", () => {
      process.env.MYO_USER_ID = "env-user";
      const client = new MyobotRelayClient({
        enabled: true,
        supabaseUrl: "https://example.supabase.co",
        supabaseAnonKey: "key",
      });
      const result = client.canStart();
      expect(result.ok).toBe(true);
    });
  });
});

describe("RelayConfig type", () => {
  test("accepts valid config", () => {
    const config: RelayConfig = {
      enabled: true,
      autoConnect: true,
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "anon-key",
      userId: "user-123",
      gatewayId: "gateway-abc",
      reconnect: true,
      reconnectDelayMs: 5000,
      heartbeatIntervalMs: 30000,
    };
    expect(config).toBeDefined();
  });

  test("accepts minimal config", () => {
    const config: RelayConfig = {};
    expect(config).toBeDefined();
  });
});
