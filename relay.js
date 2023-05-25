import { X509Certificate, createHash, randomBytes } from 'crypto';
import { EventEmitter } from 'events';
import ipaddr from 'ipaddr.js';
import { Socket, connect } from 'net';
import { connect as connectTLS } from 'tls';

/**
 * @param {string | Buffer} cert
 */
function getDeviceIdFromCert(cert) {
    const x509 = new X509Certificate(cert);
    const { raw } = x509;
    const sha256 = createHash('sha256');
    sha256.update(raw);
    return sha256.digest();
}

/**
 * @param {Socket} socket
 */
function socketReadable(socket) {
    if (socket.readableLength > 0) {
        return Promise.resolve(socket.readableLength);
    }
    let onReadable, onError, onEnd;
    return new Promise((resolve, reject) => {
        socket.resume();
        socket.on(
            'readable',
            (onReadable = () => {
                socket.pause();
                resolve(socket.readableLength);
            })
        );
        socket.on('error', (onError = (err) => reject(err)));
        socket.on(
            'end',
            (onEnd = () => reject(new Error('Unexpected stream end')))
        );
    }).finally(() => {
        socket.off('readable', onReadable);
        socket.off('error', onError);
        socket.off('end', onEnd);
    });
}

/**
 * @param {Socket} socket
 * @param {number} bytes
 */
async function readUntilBytes(socket, bytes) {
    const buffers = [];
    let bytesLeft = bytes;
    while (bytesLeft > 0) {
        const readableLength = await socketReadable(socket);
        /** @type {Buffer} */
        const buf = socket.read(Math.min(readableLength, bytesLeft));
        if (buf) {
            bytesLeft -= buf.length;
            buffers.push(buf);
        }
    }
    return Buffer.concat(buffers);
}

/**
 * @param {number} length
 * @param {(buf: Buffer) => void} writeOperation
 * @returns {Buffer}
 */
function newBuffer(length, writeOperation) {
    const buf = Buffer.alloc(length);
    writeOperation(buf);
    return buf;
}

/**
 * @param {Buffer} buffer
 * @param {number} offset
 * @returns {[Buffer, number]}
 */
function readXDRByteArray(buffer, offset) {
    const len = buffer.readUInt32BE(offset);
    const lenWithPadding = Math.ceil(len / 4) * 4;
    return [
        buffer.subarray(offset + 4, offset + 4 + len),
        offset + 4 + lenWithPadding
    ];
}

/**
 * @param {Buffer} buffer
 */
function writeXDRByteArray(buffer) {
    const lenWithPadding = Math.ceil(buffer.length / 4) * 4;
    const bufWithPadding = Buffer.alloc(4 + lenWithPadding);
    bufWithPadding.writeUInt32BE(buffer.length);
    buffer.copy(bufWithPadding, 4);
    return bufWithPadding;
}

const HEADER_MAGIC = 0x9e79bc40;
/**
 * @param {Socket} socket
 */
async function readHeader(socket) {
    const buf = await readUntilBytes(socket, 12);
    const magic = buf.readUInt32BE(0);
    const messageType = buf.readUInt32BE(4);
    const messageLength = buf.readUInt32BE(8);
    if (magic !== HEADER_MAGIC) {
        throw new Error('magic mismatch');
    }
    return { messageType, messageLength };
}

function writeHeader(messageType, messageLength) {
    const buf = Buffer.alloc(12);
    buf.writeUInt32BE(HEADER_MAGIC, 0);
    buf.writeUInt32BE(messageType, 4);
    buf.writeUInt32BE(messageLength, 8);
    return buf;
}

/**
 * @typedef {{ type: string, [key: string]: any }} Message
 * @type {((buffer: Buffer, socket: Socket) => Message)[]}
 */
const messageTypeReaders = [
    (buffer) => ({ type: 'ping' }),
    (buffer) => ({ type: 'pong' }),
    (buffer) => {
        const [bytes] = readXDRByteArray(buffer, 0);
        return {
            type: 'joinRelayRequest',
            token: bytes.toString('utf-8')
        };
    },
    (buffer) => {
        const [bytes] = readXDRByteArray(buffer, 0);
        return {
            type: 'joinSessionRequest',
            key: bytes
        };
    },
    (buffer) => {
        const code = buffer.readInt32BE(0);
        const [message] = readXDRByteArray(buffer, 4);
        return {
            type: 'response',
            code,
            message: message.toString('utf-8')
        };
    },
    (buffer) => {
        const [id] = readXDRByteArray(buffer, 0);
        return {
            type: 'connectRequest',
            id
        };
    },
    (buffer, socket) => {
        const [from, keyOffset] = readXDRByteArray(buffer, 0);
        const [key, addressOffset] = readXDRByteArray(buffer, keyOffset);
        const [addressBytes, portOffset] = readXDRByteArray(
            buffer,
            addressOffset
        );
        const port = buffer.readUInt32BE(portOffset);
        const serverSocket = buffer.readUInt32BE(portOffset + 4);
        let address = socket.remoteAddress;
        if (addressBytes.length > 0) {
            const addressStr = ipaddr
                .fromByteArray(Uint8Array.from(address))
                .toString();
            if (addressStr !== '0.0.0.0' && addressStr !== '::') {
                address = addressStr;
            }
        }
        return {
            type: 'sessionInvitation',
            from,
            key,
            address,
            port: port & 0xffff,
            serverSocket: (serverSocket & 0x1) === 0x1
        };
    },
    (buffer) => ({ type: 'relayFull' })
];

/**
 * @param {Socket} socket
 */
async function readMessage(socket) {
    const header = await readHeader(socket);
    const messageBuf = await readUntilBytes(socket, header.messageLength);
    const reader = messageTypeReaders[header.messageType];
    if (!reader) {
        throw new Error(`Illegal message type: ${header.messageType}`);
    }
    return reader(messageBuf, socket);
}

/**
 * @param {Socket} socket
 * @param {Message} message
 */
function writeMessage(socket, message) {
    let buffers = [];
    let messageType;
    switch (message.type) {
        case 'ping':
            messageType = 0;
            break;
        case 'pong':
            messageType = 1;
            break;
        case 'joinRelayRequest':
            messageType = 2;
            buffers.push(
                writeXDRByteArray(Buffer.from(message.token, 'utf-8'))
            );
            break;
        case 'joinSessionRequest':
            messageType = 3;
            buffers.push(writeXDRByteArray(message.key));
            break;
        case 'response':
            messageType = 4;
            buffers.push(
                newBuffer(4, (buf) => buf.writeInt32BE(message.code, 0)),
                writeXDRByteArray(Buffer.from(message.message, 'utf-8'))
            );
            break;
        case 'connectRequest':
            messageType = 5;
            buffers.push(writeXDRByteArray(message.id));
            break;
        case 'sessionInvitation':
            messageType = 6;
            buffers.push(
                writeXDRByteArray(message.from),
                writeXDRByteArray(message.key),
                writeXDRByteArray(
                    Buffer.from(ipaddr.parse(message.address).toByteArray())
                ),
                newBuffer(4, (buf) => buf.writeUInt32BE(message.port, 0)),
                newBuffer(4, (buf) =>
                    buf.writeUInt32BE(message.serverSocket ? 1 : 0, 0)
                )
            );
        case 'relayFull':
            messageType = 7;
            break;
        default:
            throw new Error(`Unknown message type: ${message.type}`);
    }
    const content = Buffer.concat(buffers);
    const header = writeHeader(messageType, content.length);
    socket.write(header);
    socket.write(content);
}

/**
 * @param {Socket} socket
 */
async function sendJoinRelay(socket, token) {
    writeMessage(socket, {
        type: 'joinRelayRequest',
        token
    });
    const message = await readMessage(socket);
    if (message.type === 'response') {
        if (message.code !== 0) {
            throw new Error(message.message);
        }
    } else if (message.type === 'relayFull') {
        throw new Error('relay full');
    } else {
        throw new Error(
            `protocol error: expecting response got ${message.type}`
        );
    }
}

/**
 * @param {Socket} socket
 */
async function messageLoop(socket, onInvitation) {
    while (socket.readyState === 'open') {
        const message = await readMessage(socket);
        if (message.type === 'ping') {
            writeMessage(socket, { type: 'pong' });
        } else if (message.type === 'sessionInvitation') {
            if (onInvitation) {
                await onInvitation(message);
            }
        } else if (message.type === 'relayFull') {
            throw new Error('relay full');
        } else {
            throw new Error(
                `protocol error: unexpected message ${message.type}`
            );
        }
    }
}

/**
 * @param {Socket} socket
 */
async function sendJoinSession(socket, key) {
    writeMessage(socket, {
        type: 'joinSessionRequest',
        key
    });
    const message = await readMessage(socket);
    if (message.type === 'response') {
        if (message.code !== 0) {
            throw new Error(message.message);
        }
    } else {
        throw new Error(
            `protocol error: expecting response got ${message.type}`
        );
    }
}

/**
 * @param {Socket} socket
 */
async function sendConnectRequest(socket, id) {
    writeMessage(socket, {
        type: 'connectRequest',
        id
    });
    const message = await readMessage(socket);
    if (message.type === 'sessionInvitation') {
        return message;
    } else if (message.type === 'response') {
        throw new Error(message.message);
    } else {
        throw new Error(
            `protocol error: expecting response got ${message.type}`
        );
    }
}

function establishConnection(host, port, connectOptions) {
    let socket, onError;
    return new Promise((resolve, reject) => {
        socket = connect({ host, port, ...connectOptions }, () =>
            resolve(socket)
        );
        socket.on('error', (onError = (err) => reject(err)));
    }).finally(() => {
        socket.off('error', onError);
    });
}

function establishTLSConnection(host, port, cert, key, connectOptions) {
    let socket, onError;
    return new Promise((resolve, reject) => {
        socket = connectTLS(
            {
                host,
                port,
                cert,
                key,
                rejectUnauthorized: false,
                ALPNProtocols: ['bep-relay'],
                ...connectOptions
            },
            () => resolve(socket)
        );
        socket.on('error', (onError = (err) => reject(err)));
    }).finally(() => {
        socket.off('error', onError);
    });
}

async function joinSession(invitation, connectOptions) {
    const socket = await establishConnection(
        invitation.address,
        invitation.port,
        connectOptions
    );
    await sendJoinSession(socket, invitation.key);
    return socket;
}

export class RelayClient extends EventEmitter {
    constructor(cert, key) {
        super();
        this.cert = cert;
        this.key = key;
        this.deviceId = getDeviceIdFromCert(cert);
        this.connectOptions = {
            timeout: 60 * 1000
        };
    }

    async joinRelay(host, port, token) {
        this.relaySocket = await establishTLSConnection(
            host,
            port,
            this.cert,
            this.key,
            this.connectOptions
        );
        await sendJoinRelay(this.relaySocket, token);
    }

    listen() {
        messageLoop(this.relaySocket, async (invitation) => {
            const conn = await joinSession(invitation, this.connectOptions);
            conn.fromDeviceId = invitation.from;
            this.emit('connection', conn);
        }).catch((err) => {
            if (!this.relaySocket) return;
            this.emit('error', err);
        });
    }

    close() {
        this.relaySocket.end();
        this.relaySocket = null;
    }

    async waitForConnection() {
        return new Promise((resolve, reject) => {
            this.once('connection', (conn) => resolve(conn));
            this.once('error', (err) => reject(err));
        });
    }

    async connect(deviceId) {
        const invitation = await sendConnectRequest(this.relaySocket, deviceId);
        const conn = await joinSession(invitation, this.connectOptions);
        return conn;
    }
}

async function testConnection(sentSocket, receivedSocket, size) {
    const sentBytes = randomBytes(size);
    const receivedBytesPromise = readUntilBytes(
        receivedSocket,
        sentBytes.length
    );
    sentSocket.write(sentBytes);
    const timeoutError = new Error(`Timeout`);
    let timeout;
    const timeoutPromise = new Promise(
        (_, reject) =>
            (timeout = setTimeout(() => reject(timeoutError), 60 * 1000))
    );
    const receivedBytes = await Promise.race([
        receivedBytesPromise,
        timeoutPromise
    ]).finally(() => {
        clearTimeout(timeout);
    });
    if (Buffer.compare(sentBytes, receivedBytes) !== 0) {
        throw new Error('Incorrect data');
    }
}

export async function testProxy({
    host,
    port,
    token,
    serverCert,
    serverKey,
    clientCert,
    clientKey
}) {
    let serverClient, clientClient, serverConn, clientConn;
    let lastError = null;
    let establishTime = 0;
    let handshakeTime = 0;
    try {
        const establishStart = process.hrtime.bigint();
        serverClient = new RelayClient(serverCert, serverKey);
        clientClient = new RelayClient(clientCert, clientKey);
        console.log('Starting to connect to relay');
        await serverClient.joinRelay(host, port, token);
        console.log('Server connected to relay successfully');
        serverClient.listen();
        const serverConnPromise = serverClient.waitForConnection();
        await clientClient.joinRelay(host, port, token);
        console.log('Client connected to relay successfully');
        clientConn = await clientClient.connect(serverClient.deviceId);
        console.log('Client starts to proxy');
        serverConn = await serverConnPromise;
        console.log('Server starts to proxy');
        establishTime = Number(
            (process.hrtime.bigint() - establishStart) / 1000000n
        );
        const handshakeStart = process.hrtime.bigint();
        await testConnection(serverConn, clientConn, 128);
        console.log('Proxy from server to client successfully');
        await testConnection(clientConn, serverConn, 128);
        console.log('Proxy from client to server successfully');
        handshakeTime = Number(
            (process.hrtime.bigint() - handshakeStart) / 1000000n
        );
    } catch (err) {
        lastError = err;
    }
    try {
        if (serverConn) serverConn.end();
        if (clientConn) clientConn.end();
        if (serverClient) serverClient.close();
        if (clientClient) clientClient.close();
    } catch (_) {}
    return { establishTime, handshakeTime, lastError };
}
