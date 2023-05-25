import { got } from 'got';
import { createConnection } from 'mysql2/promise';
import whyIsNodeRunning from 'why-is-node-running';
import config from './config.js';
import { testProxy } from './relay.js';

async function insertTable(conn, tableName, obj) {
    const entries = Object.entries(obj);
    const keys = entries.map((e) => e[0]);
    const parameterSql = keys.map((e) => '?');
    const values = entries.map((e) => e[1]);
    const sql = `INSERT INTO ${tableName} (${keys.join(
        ','
    )}) VALUES (${parameterSql.join(',')})`;
    return await conn.execute(sql, values);
}

async function main() {
    const conn = await createConnection(config.mysql);
    await conn.execute(`CREATE TABLE IF NOT EXISTS events (
        id int PRIMARY KEY AUTO_INCREMENT,
        time datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
        bytes_proxied bigint NOT NULL,
        kbps_10s int NOT NULL,
        kbps_1m int NOT NULL,
        kbps_5m int NOT NULL,
        kbps_15m int NOT NULL,
        kbps_30m int NOT NULL,
        kbps_60m int NOT NULL,
        num_active_sessions int NOT NULL,
        num_connections int NOT NULL,
        num_pending_session_keys int NOT NULL,
        num_proxies int NOT NULL,
        uptime_seconds int NOT NULL,
        establish_time int NOT NULL,
        handshake_time int NOT NULL
    )`);
    const status = await got(`${config.relayStatusUrl}/status`).json();
    let proxyStatus = { establishTime: 0, handshakeTime: 0 };
    try {
        proxyStatus = await testProxy(config.relay);
    } catch(err) {
        console.error(err);
    }
    insertTable(conn, 'events', {
        bytes_proxied: status.bytesProxied,
        kbps_10s: status.kbps10s1m5m15m30m60m[0],
        kbps_1m: status.kbps10s1m5m15m30m60m[1],
        kbps_5m: status.kbps10s1m5m15m30m60m[2],
        kbps_15m: status.kbps10s1m5m15m30m60m[3],
        kbps_30m: status.kbps10s1m5m15m30m60m[4],
        kbps_60m: status.kbps10s1m5m15m30m60m[5],
        num_active_sessions: status.numActiveSessions,
        num_connections: status.numConnections,
        num_pending_session_keys: status.numPendingSessionKeys,
        num_proxies: status.numProxies,
        uptime_seconds: status.uptimeSeconds,
        establish_time: proxyStatus.establishTime,
        handshake_time: proxyStatus.handshakeTime
    })
    await conn.end();
    // process.exit(0);
}

main().catch((err) => {
    console.error(err);
    debugger;
    process.exit(1);
});
