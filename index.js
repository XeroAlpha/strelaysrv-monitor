import { type as getSystem } from 'os';
import { inspect } from 'util';
import { got } from 'got';
import { createConnection } from 'mysql2/promise';
import whyIsNodeRunning from 'why-is-node-running';
import { procfs } from '@stroncium/procfs';
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

async function getActualKbps(ni, time) {
    let stat = {
        receive: {
            kbps: 0,
            pps: 0
        },
        transmit: {
            kbps: 0,
            pps: 0
        }
    };
    if (getSystem() == "Linux") {
        const devInfoStart = procfs.netDev().find((dev) => dev.name === ni);
        await new Promise((r) => setTimeout(() => r(), time));
        const devInfoEnd = procfs.netDev().find((dev) => dev.name === ni);
        if (devInfoStart && devInfoEnd) {
            stat.receive.kbps = Math.floor((devInfoEnd.rxBytes - devInfoStart.rxBytes) / time * 8);
            stat.receive.pps = Math.floor((devInfoEnd.rxPackets - devInfoStart.rxPackets) / time * 1000);
            stat.transmit.kbps = Math.floor((devInfoEnd.txBytes - devInfoStart.txBytes) / time * 8);
            stat.transmit.pps = Math.floor((devInfoEnd.txPackets - devInfoStart.txPackets) / time * 1000);
        }
    }
    return stat;
}

async function main() {
    const conn = await createConnection(config.mysql);
    await conn.execute(`CREATE TABLE IF NOT EXISTS events (
        id int PRIMARY KEY AUTO_INCREMENT,
        time datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
        bytes_proxied bigint NOT NULL,
        rx_kbps_10s int NOT NULL,
        tx_kbps_10s int NOT NULL,
        rx_pps_10s int NOT NULL,
        tx_pps_10s int NOT NULL,
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
        handshake_time int NOT NULL,
        last_error text NOT NULL
    )`);
    const pendingNetwordInfo = getActualKbps('eth0', 10 * 1000);
    const status = await got(`${config.relayStatusUrl}/status`).json();
    let proxyStatus = { establishTime: -1, handshakeTime: -1 };
    try {
        proxyStatus = await testProxy(config.relay);
    } catch(err) {
        proxyStatus.lastError = err;
        console.error(err);
    }
    const networkInfo = await pendingNetwordInfo;
    insertTable(conn, 'events', {
        bytes_proxied: status.bytesProxied,
        rx_kbps_10s: networkInfo.receive.kbps,
        tx_kbps_10s: networkInfo.transmit.kbps,
        rx_pps_10s: networkInfo.receive.pps,
        tx_pps_10s: networkInfo.transmit.pps,
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
        handshake_time: proxyStatus.handshakeTime,
        last_error: proxyStatus.lastError ? inspect(proxyStatus.lastError) : ''
    });
    await conn.end();
    const deferTimeout = setTimeout(() => {
        process.exit(1);
    }, 5000);
    deferTimeout.unref();
}

main().catch((err) => {
    console.error(err);
    debugger;
    process.exit(1);
});
