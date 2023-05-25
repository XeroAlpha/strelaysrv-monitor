/** @type {string} */
const clientCert = `<put your client certificate (pem format) here>`;
/** @type {string} */
const clientKey = `<put your client key (pem format) here>`;
/** @type {string} */
const serverCert = `<put your server certificate (pem format) here>`;
/** @type {string} */
const serverKey = `<put your server key (pem format) here>`

export default {
    mysql: {
        host: '<mysql server host>',
        user: '<mysql user>',
        password: '<mysql password>',
        database: '<mysql database>'
    },
    relay: {
        host: '127.0.0.1',
        port: 22067,
        token: '',
        serverCert,
        serverKey,
        clientCert,
        clientKey
    },
    relayStatusUrl: 'http://127.0.0.1:22070'
};