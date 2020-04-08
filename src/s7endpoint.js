//@ts-check
/*
    Copyright (c) 2019 Guilherme Francescon Cittolin

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
*/
/*jshint esversion: 6, node: true*/

const { EventEmitter } = require('events')
//@ts-ignore
const constants = require('./constants.json');
const util = require('util');
const debug = util.debuglog('nodes7');
const isoOnTcp = require('iso-on-tcp');

const S7Connection = require('./s7connection.js');

const CONN_DISCONNECTED = 0;
const CONN_CONNECTING = 1;
const CONN_CONNECTED = 2;
const CONN_DISCONNECTING = 3;

/**
 * Emitted when an error occurs with the underlying
 * transport or the underlying connection
 * @event S7Endpoint#error
 * @param {*} e the error
 */

/**
 * Represents a S7 PLC, handling the connection to it and
 * allowing to call methods that act on it
 */
class S7Endpoint extends EventEmitter {

    /**
     * Creates a new S7Endpoint
     * 
     * @param {object}  opts the options object
     * @param {string}  [opts.type] the type of the connection to the PLC, either "tcp" or "mpi". If left undefined, will be automatically infered from the presence of the "host" or the "mpiAdapter" parameters
     * @param {string}  [opts.host] the hostname or IP Address to connect to. Infers "tcp" type of connection
     * @param {number}  [opts.port=102] the TCP port to connect to
     * @param {number}  [opts.rack=0] the rack on the PLC configuration
     * @param {number}  [opts.slot=2] the slot on the PLC configuration
     * @param {number}  [opts.srcTSAP=0x0100] the source TSAP, when connecting using TSAP method
     * @param {number}  [opts.dstTSAP=0x0102] the destination TSAP, when connecting using TSAP method
     * @param {*}       [opts.mpiAdapter] the MPI adapter used to communicate to the PLC. Infers "mpi" type of connection
     * @param {number}  [opts.mpiAddress=2] the address of the PLC on the MPI bus
     * @param {number}  [opts.autoReconnect=5000] the time to wait before trying to connect to the PLC again, in ms. If set to 0, disables the functionality
     * @param {object}  [opts.s7ConnOpts] the {@link S7Connection} constructor options, allowing to fine-tune specific parameters
     * 
     * @throws {Error} Will throw an error if invalid options are passed
     */
    constructor(opts) {
        debug("new S7Endpoint", opts);

        super();

        opts = opts || {};

        // try to infer the connection type based on the present parameters
        if (!opts.type) {
            if (opts.host) {
                this._connType = "tcp"
            } else if (opts.mpiAdapter) {
                this._connType = "mpi"
            }
        } else {
            this._connType = opts.type;
        }


        this._autoReconnect = opts.autoReconnect !== undefined ? opts.autoReconnect : 5000;
        this._connOptsS7 = opts.s7ConnOpts || {};

        // get and validate parameters
        if (this._connType == "tcp") {
            if (!opts.host) {
                throw new Error("Parameter 'host' is required for 'tcp' type of connection");
            }

            let dstTSAP;
            if (typeof opts.dstTSAP === 'number') {
                dstTSAP = opts.dstTSAP;
            } else {
                let rack = typeof opts.rack === 'number' ? opts.rack : 0;
                let slot = typeof opts.slot === 'number' ? opts.slot : 2;

                dstTSAP = 0x0100 | (rack << 5) | slot;
            }

            this._connOptsTcp = {
                host: opts.host,
                port: opts.port || 102,
                srcTSAP: opts.srcTSAP || 0x0100,
                dstTSAP: dstTSAP,
                forceClose: true //we don't send DR telegrams of ISO-on-TCP
            }
        } else if (this._connType == "mpi") {
            if (!opts.mpiAdapter) {
                throw new Error("Parameter 'mpiAdapter' is required for 'mpi' type of connection");
            }

            this._mpiAdapter = opts.mpiAdapter;
            this._mpiAdapter.on('error', e => this._onMpiAdapterError);
            this._connOptsMpi = {
                mpiAddress: typeof opts.mpiAddress === 'number' ? opts.mpiAddress : 2
            }

            this._connOptsS7.maxJobs = 1; // TODO FIXME a (maybe) bug in MpiAdapter prevents us to handle more than 1
        } else {
            throw new Error(`Unknown type parameter "${opts.type}"`);
        }

        this._initParams();

        if (this._autoReconnect > 0) {
            this._connect();
        }
    }

    _initParams() {
        this._connectionState = CONN_DISCONNECTED;
        this._connection = null;
        this._transport = null;
        this._pduSize = null;
        this._reconnectTimer = null;
    }

    _connect() {
        debug("S7Endpoint _connect");

        clearTimeout(this._reconnectTimer);

        if (this._connectionState > CONN_DISCONNECTED) {
            debug("S7Endpoint _connect not-disconnected");
            return;
        }

        this._destroyConnection();
        this._destroyTransport();

        this._connectionState = CONN_CONNECTING;

        if (this._connType == 'tcp') {

            this._transport = isoOnTcp.createConnection(this._connOptsTcp, () => {
                if (this._connection) this._connection.connect();
            });
            this._connectS7();
        } else if (this._connType == 'mpi') {

            if (!this._mpiAdapter.isConnected) {
                debug("S7Endpoint _connect not-disconnected");
                this._connectionState = CONN_DISCONNECTED;
                this._mpiAdapter.once('connect', () => this._connect());
                return;
            }

            let mpiAddr = this._connOptsMpi.mpiAddress;
            this._mpiAdapter.createStream(mpiAddr, this._connOptsMpi).then(stream => {
                this._transport = stream;
                this._connectS7();
                this._connection.connect();
            }).catch(e => this._onMpiAdapterError(e));
        }
    }

    _connectS7() {
        debug("S7Endpoint _connectS7");

        this._transport.on('error', e => this._onTransportError(e));
        this._transport.on('close', () => this._onTransportClose());
        this._transport.on('end', () => this._onTransportEnd());

        this._connection = new S7Connection(this._transport, this._connOptsS7);

        this._connection.on('error', e => this._onConnectionError(e));
        this._connection.on('connect', () => this._onConnectionConnected());
        this._connection.on('timeout', () => this._onConnectionTimeout());
    }

    /**
     * Destroys the current S7Connection
     * 
     * @private
     * @param {boolean} [skipReconnect=false]
     */
    _destroyConnection(skipReconnect) {
        debug("S7Endpoint _destroyConnection");

        this._connectionState = CONN_DISCONNECTED;
        clearTimeout(this._reconnectTimer); //ensure we're not trying again if skipReconnect=true

        if (!this._connection) return;

        this._connection.destroy();
        if (!skipReconnect) this._scheduleReconnection();

        this._connection = null;
    }

    /**
     * Destroys the underlying transport. This also
     * destroys the S7Connection
     * @private
     */
    _destroyTransport() {
        debug("S7Endpoint _destroyTransport");

        //if we're destroying the transport, the connection must also die
        this._destroyConnection();

        if (!this._transport) return;

        if (this._transport.destroy) {
            this._transport.destroy();
        } else if (this._transport._destroy) {
            this._transport._destroy();
        }

        this._transport = null;
        /**
         * Emitted when we have disconnected from the PLC
         * @event S7Endpoint#disconnect
         */
        this.emit('disconnect');
    }

    /**
     * Tries to gracefully close the underlying transport by
     * calling end()
     * @private
     */
    _closeTransport() {
        debug("S7Endpoint _closeTransport");

        this._connectionState = CONN_DISCONNECTED;

        if (!this._transport) return;

        this._transport.end();
    }

    /**
     * Starts the disconnection process by destroying the
     * S7Connection and then asking for the transport to close.
     * If the process was started by the user, it won't schedule
     * another reconnection
     * 
     * @private
     * @param {boolean} [byUser] whether the disconnection was triggered by the user
     */
    _disconnect(byUser) {
        debug("S7Endpoint _disconnect");

        this._connectionState = CONN_DISCONNECTED;

        this._destroyConnection(byUser);
        this._closeTransport();

    }

    _onTransportClose() {
        debug("S7Endpoint _onTransportClose");

        this._destroyTransport();
    }

    _onTransportEnd() {
        debug("S7Endpoint _onTransportEnd");

        this._destroyTransport();
    }

    /**
     * Triggered when any request of the S7Connection
     * has timed out. Generally means we need to
     * reconnect to the PLC
     * @private
     */
    _onConnectionTimeout() {
        debug("S7Endpoint _onConnectionTimeout");

        // TODO maybe add an option to control this behavior
        this._disconnect();
    }

    _onTransportError(e) {
        debug("S7Endpoint _onTransportError", e);

        this._destroyTransport();

        this.emit('error', e);
    }

    _onConnectionError(e) {
        debug("S7Endpoint _onConnectionError", e);

        // errors from S7Connection should be 'softer' errors, so let's try a clean disconnect
        this._disconnect();

        this.emit('error', e);
    }

    _onMpiAdapterError(e) {
        debug("S7Endpoint _onMpiAdapterError", e);

        this._destroyConnection();
        this._destroyTransport();

        this.emit('error', e);
    }

    /**
     * Schedule a reconnection to the PLC if this
     * was configured in the constructor options
     * @private
     */
    _scheduleReconnection() {
        debug("S7Endpoint _scheduleReconnection");

        clearTimeout(this._reconnectTimer);

        if (this._autoReconnect > 0) {
            this._reconnectTimer = setTimeout(() => {
                debug("S7Endpoint _scheduleReconnection timeout-fired");
                this._connect();
            }, this._autoReconnect);
        }
    }

    _onConnectionConnected() {
        debug("S7Endpoint _onConnectionConnected");

        if (this._pduSize != this._connection.pduSize) {
            /**
             * Emitted when the negotiated PDU size has changed
             * @event S7Connection#pdu-size
             * @param {number} pduSize the new PDU size negotiated
             */
            this.emit("pdu-size", this._connection.pduSize);
        }
        this._pduSize = this._connection.pduSize;

        this._connectionState = CONN_CONNECTED;
        /**
         * Emitted when we're connected to the PLC and
         * ready to communicate
         * @event S7Endpoint#connect
         */
        this.emit('connect');
    }

    // ----- public methods

    /**
     * Connects to the PLC. Note that this will be automatically
     * called if the autoReconnect parameter of the constructor 
     * is not zero.
     */
    connect() {
        debug("S7Endpoint connect");

        return new Promise((res, rej) => {
            if (this._connectionState === CONN_CONNECTED) {
                res();
            } else if (this._connectionState === CONN_DISCONNECTING) {
                rej(new Error("Can't connect when connection state is 'DISCONNECTING' "))
            } else {
                this.once('connect', res);
                this.once('error', rej);
                this._connect();
            }
        });
    }


    /**
     * Disconnects from the PLC. 
     */
    disconnect() {
        debug("S7Endpoint disconnect");

        return new Promise((res, rej) => {
            if (this._connectionState === CONN_DISCONNECTED) {
                res();
            } else {
                this.once('disconnect', res);
                this.once('error', rej);
                this._disconnect(true);
            }
        });
    }

    /**
     * Whether we're currently connected to the PLC or not
     */
    get isConnected() {
        return this._connectionState === CONN_CONNECTED;
    }

    /**
     * The currently negotiated pdu size
     */
    get pduSize() {
        return this._pduSize;
    }


    /**
     * Reads multiple values from multiple PLC areas. Care must be
     * taken not to exceed the maximum PDU size both of the request
     * and the response telegrams
     * 
     * @param {object[]} items the array of items to send
     * @param {number} items[].area the area code to be read
     * @param {number} [items[].db] the db number to be read (in case of a DB)
     * @param {number} items[].transport the transport length
     * @param {number} items[].address the address where to read from
     * @param {number} items[].length the number of elements to read (according to transport)
     */
    async readVars(items) {
        debug('S7Endpoint readVars', items);

        if (this._connectionState !== CONN_CONNECTED) {
            throw new Error("Not connected");
        }

        let arr = [];
        for (const item of items) {
            //first 3 bits for bit address is irrelevant for transports other than BIT
            let bitAddr = item.transport === constants.proto.transport.BIT;
            arr.push({
                syntax: constants.proto.syntax.S7ANY,
                area: item.area,
                db: item.db,
                transport: item.transport,
                address: bitAddr ? item.address : item.address << 3,
                length: item.length
            });
        }

        return await this._connection.requestReadVars(arr);
    }

    /**
     * Reads arbitrary length of data from a memory area of 
     * the PLC. This method accounts for the negotiated PDU 
     * size and splits it in multiple requests if necessary
     * 
     * @param {number} area the code of the area to be read
     * @param {number} address the address where to read from
     * @param {number} length the amount of bytes to read
     * @param {number} [db] the db number to be read (in the case area is a DB)
     * @returns {Promise<Buffer>}
     */
    async readArea(area, address, length, db) {
        debug('S7Endpoint readArea', area, address, length, db);

        if (this._connectionState !== CONN_CONNECTED) {
            throw new Error("Not connected");
        }

        let maxPayload = this._pduSize - 18; //protocol overhead
        let requests = [];
        for (let ptr = 0; ptr < length; ptr += maxPayload) {
            let item = [{
                area, db,
                address: address,
                transport: constants.proto.transport.BYTE,
                length: Math.min(length - ptr, maxPayload)
            }];
            requests.push(this.readVars(item));
        }

        return Promise.all(requests).then(results => {
            debug('S7Endpoint readArea response', results);

            let data = [];
            for (const res of results) {
                if (res.length > 1) throw new Error("Illegal item count on PLC response");

                let code = res[0].returnCode;
                if (code !== constants.proto.retval.DATA_OK) {
                    let errDescr = constants.proto.retvalDesc[code] || '<Unknown return code>';
                    throw new Error(`Read error [0x${code.toString(16)}]: ${errDescr}`);
                }

                // TODO should we check the transport of the response?
                data.push(res[0].data);
            }

            return Buffer.concat(data);
        });
    }

    /**
     * Reads data from a DB
     *
     * @param {number} db the number of the DB to be read
     * @param {number} address the address where to read from
     * @param {number} length the amount of bytes to read
     * @returns {Promise<Buffer>}
     */
    async readDB(db, address, length) {
        debug('S7Endpoint readDB', db, address, length);

        return await this.readArea(constants.proto.area.DB, address, length, db);
    }

    /**
     * Reads data from the inputs area
     *
     * @param {number} address the address where to read from
     * @param {number} length the amount of bytes to read
     * @returns {Promise<Buffer>}
     */
    async readInputs(address, length) {
        debug('S7Endpoint readInputs', address, length);

        return await this.readArea(constants.proto.area.INPUTS, address, length);
    }

    /**
     * Reads data from the outputs area
     *
     * @param {number} address the address where to read from
     * @param {number} length the amount of bytes to read
     * @returns {Promise<Buffer>}
     */
    async readOutputs(address, length) {
        debug('S7Endpoint readOutputs', address, length);

        return await this.readArea(constants.proto.area.OUTPUTS, address, length);
    }

    /**
     * Reads data from the flags (memory / merker) area
     *
     * @param {number} address the address where to read from
     * @param {number} length the amount of bytes to read
     * @returns {Promise<Buffer>}
     */
    async readFlags(address, length) {
        debug('S7Endpoint readFlags', address, length);

        return await this.readArea(constants.proto.area.FLAGS, address, length);
    }

    /**
     * Writes multiple values onto multiple PLC areas. Care must be
     * taken not to exceed the maximum PDU size both of the request
     * and the response telegrams
     *
     * @param {object[]} items the array of items to send
     * @param {number} items[].area the area code to be read
     * @param {number} [items[].db] the db number to be read (in case of a DB)
     * @param {number} items[].transport the transport length
     * @param {number} items[].address the address where to read from
     * @param {number} items[].length the number of elements to read (according to transport)
     * @param {number} items[].dataTransport the transport length of the written buffer
     * @param {Buffer} items[].data the transport length of the written buffer
     */
    async writeVars(items) {
        debug('S7Endpoint writeMultiVars', items);

        if (this._connectionState !== CONN_CONNECTED) {
            throw new Error("Not connected");
        }

        let param = [], data = [];
        for (const item of items) {
            //first 3 bits for bit address is irrelevant for transports other than BIT
            let bitAddr = item.transport === constants.proto.transport.BIT;

            param.push({
                syntax: constants.proto.syntax.S7ANY,
                area: item.area,
                db: item.db,
                transport: item.transport,
                address: bitAddr ? item.address : item.address << 3,
                length: item.length
            });
            data.push({
                transportSize: item.dataTransport,
                data: item.data
            });
        }

        return await this._connection.requestWriteVar(param, data);
    }

    /**
     * Writes arbitrary length of data into a memory area of 
     * the PLC. This method accounts for the negotiated PDU 
     * size and splits it in multiple requests if necessary
     * 
     * @param {number} area the code of the area to be written
     * @param {number} address the address where to write to
     * @param {Buffer} data the data to be written
     * @param {number} [db] the db number to be written (in the case area is a DB)
     * @returns {Promise<void>}
     */
    async writeArea(area, address, data, db) {
        debug('S7Endpoint writeArea', area, address, data, db);

        if (this._connectionState !== CONN_CONNECTED) {
            throw new Error("Not connected");
        }

        let maxPayload = this._pduSize - 28; //protocol overhead
        let requests = [];
        let dataLength = data.length;
        for (let ptr = 0; ptr < dataLength; ptr += maxPayload) {
            let chunk = data.slice(ptr, Math.min(dataLength - ptr, maxPayload))
            let item = [{
                area, db,
                address: address,
                transport: constants.proto.transport.BYTE,
                dataTransport: constants.proto.dataTransport.BBYTE,
                data: chunk,
                length: chunk.length
            }];
            requests.push(this.writeVars(item));
        }

        return Promise.all(requests).then(results => {
            debug('S7Endpoint writeArea response', results);

            for (const res of results) {
                if (res.length > 1) throw new Error("Illegal item count on PLC response");

                let code = res[0].returnCode;
                if (code !== constants.proto.retval.DATA_OK) {
                    let errDescr = constants.proto.retvalDesc[code] || '<Unknown return code>';
                    throw new Error(`Write error [0x${code.toString(16)}]: ${errDescr}`);
                }
            }
        });
    }

    /**
     * Writes data into a DB
     *
     * @param {number} db the number of the DB to be written
     * @param {number} address the address where to write to
     * @param {Buffer} data the amount of bytes to write
     * @returns {Promise<void>}
     */
    async writeDB(db, address, data) {
        debug('S7Endpoint writeDB', db, address, data && data.length);

        return await this.writeArea(constants.proto.area.DB, address, data, db);
    }

    /**
     * Writes data into the outputs area
     *
     * @param {number} address the address where to write to
     * @param {Buffer} data the amount of bytes to write
     * @returns {Promise<void>}
     */
    async writeOutputs(address, data) {
        debug('S7Endpoint writeOutputs', address, data && data.length);

        return await this.writeArea(constants.proto.area.OUTPUTS, address, data);
    }

    /**
     * Writes data into the flags (memory / merker) area
     *
     * @param {number} address the address where to write to
     * @param {Buffer} data the amount of bytes to write
     * @returns {Promise<void>}
     */
    async writeFlags(address, data) {
        debug('S7Endpoint writeFlags', address, data && data.length);

        return await this.writeArea(constants.proto.area.FLAGS, address, data);
    }

    async blockCount() {
        debug('S7Endpoint blockCount');

        return await this._connection.blockCount();
    }

    async listBlocks(type) {
        debug('S7Endpoint listBlocks');
        
        return await this._connection.listBlocks(type);
    }

    async getBlockInfo(type, number, filesystem) {
        debug('S7Endpoint getBlockInfo');

        return await this._connection.getBlockInfo(type, number, filesystem);
    }

    async listAllBlocks() {
        debug('S7Endpoint listAllBlocks');

        let res = {};
        let types = Object.keys(constants.proto.block.type);
        for (const type of types) {
            res[type] = await this.listBlocks(type);
        }

        return res;
    }

    async getTime() {
        debug('S7Endpoint getTime');

        return await this._connection.getTime();
    }

    async setTime(date) {
        debug('S7Endpoint setTime', date);

        await this._connection.setTime(date);
    }

    /**
     * 
     * @param {string|number} type 
     * @param {number} number 
     * @param {boolean} [headerOnly=false] if we should ask for module header (`$`) instead of complete (`_`)
     * @param {string} [filesystem='A'] the filesystem to query (`A`, `P` or `B`)
     */
    async uploadBlock(type, number, headerOnly = false, filesystem = "A") {
        debug('S7Endpoint uploadBlock', type, number, headerOnly, filesystem);

        let blkTypeId;
        switch (typeof type) {
            case 'number':
                if (isNaN(type) || type < 0 || type > 255) {
                    throw new Error(`Invalid parameter for block type [${type}]`);
                }
                blkTypeId = type;
                break;
            case 'string':
                blkTypeId = constants.proto.block.subtype[type.toUpperCase()];
                if (blkTypeId === undefined) {
                    throw new Error(`Unknown block type [${type}]`);
                }
                break;
            default:
                throw new Error(`Unknown type for parameter block type [${type}]`);
        }

        if (!['A', 'P', 'B'].includes(filesystem)) {
            throw new Error(`Unknown filesystem [${filesystem}]`);
        }

        let fileId = headerOnly ? '$' : '_';
        let blkTypeString = blkTypeId.toString(16).padStart(2, '0').toUpperCase();
        let blkNumString = number.toString().padStart(5, '0');
        let filename = fileId + blkTypeString + blkNumString + filesystem;

        if (filename.length !== 9) {
            throw new Error(`Internal error on generated filename [${filename}]`);
        }

        return await this._connection.uploadBlock(filename);
    }

    /**
     * gets a SystemStatusList specified by its ID and Index
     * @param {number} [id=0] the SSL ID
     * @param {number} [index=0] the SSL Index
     * @param {boolean} [strict=false] Whether it should verify if the requested Ids and indexes match
     * @returns {Promise<Buffer[]>}
     */
    async getSSL(id = 0, index = 0, strict = false) {
        debug('S7Endpoint getSSL', id, index);
        
        let reqBuf = Buffer.alloc(4);
        reqBuf.writeUInt16BE(id, 0);
        reqBuf.writeUInt16BE(index, 2);

        let res = await this._connection.sendUserData(constants.proto.userData.function.CPU_FUNC,
            constants.proto.userData.subfunction.CPU_FUNC.READSZL, reqBuf);

        let resId = res.readUInt16BE(0);
        let resIdx = res.readUInt16BE(2);

        if (strict && (resId !== id || resIdx !== index)) {
            throw new Error(`SSL ID/Index mismatch, requested [${id}]/[${index}], got [${resId}]/[${resIdx}]`);
        }

        let entryLength = res.readUInt16BE(4);
        let entryCount = res.readUInt16BE(6);

        if (entryLength * entryCount !== res.length - 8){
            throw new Error(`Size mismatch, expecting [${entryCount}] x [${entryLength}] + 8, got [${res.length}]`);
        }

        let retArray = [];
        for (let i = 0; i < entryCount; i++) {
            const ptr = 8 + (entryLength * i);
            retArray.push(res.slice(ptr, ptr + entryLength));
        }

        return retArray;
    }

    /**
     * Gets the available SSL IDs by querying SSL ID 0x000, Index 0x0000
     * @returns {Promise<number[]>}
     */
    async getAvailableSSL() {
        debug('S7Endpoint getAvailableSSL');
        
        let res = await this.getSSL(0, 0);
        return res.map(b => b.readUInt16BE(0));
    }
}

module.exports = S7Endpoint