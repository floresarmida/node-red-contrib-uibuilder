/**
 * Copyright (c) 2017 Julian Knight (Totally Information)
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

'use strict'

// Module name must match this nodes html file
const moduleName = 'uibuilder'

console.log( 'node-red-contrib-' + moduleName + ' - initialising module' )

const serveStatic = require('serve-static'),
      socketio = require('socket.io'),
      path = require('path'),
      fs = require('fs'),
      events = require('events'),
      nodeVersion = require('../package.json').version
      ;

// These are loaded to the /<uibuilder>/vendor URL path
const vendorPackages = [
    'normalize.css',
    'jquery',
]

var io

// The channel names for Socket.IO
const ioChannels = {control: 'uiBuilderControl', client: 'uiBuilderClient', server: 'uiBuilder'}

// Why?
//var ev = new events.EventEmitter();
//ev.setMaxListeners(0);

// Will we use "compiled" version of module front-end code?
var useCompiledCode = false
fs.stat(path.join(__dirname, 'dist', 'index.html'), function(err, stat) {
    useCompiledCode = true
})

module.exports = function(RED) {
    'use strict';

    function nodeGo(config) {
        // Create the node
        RED.nodes.createNode(this, config)

        // copy 'this' object in case we need it in context of callbacks of other functions.
        const node = this

        // Create local copies of the node configuration (as defined in the .html file)
        node.name   = config.name || ''
        node.topic  = config.topic || ''
        // TODO: This needs to be limited to a single path element
        node.url    = config.url  || 'uibuilder'
        node.fwdInMessages = config.fwdInMessages || true
        node.customFoldersReqd = config.customFoldersReqd || true
        node.userVendorPackages = config.userVendorPackages || RED.settings.uibuilder.userVendorPackages || []
        // NOTE: When a node is redeployed - e.g. after the template is changed
        //       it is totally torn down and rebuilt so we cannot ever know
        //       whether the template was changed.
        node.template = config.template || '<p>{{ msg }}</p>';
        node.ioClientsCount = 0 // how many Socket clients connected to this intance?

        // NOTE that this nodes context variables are available from (node.context()).get('varname')
        //      The node's flow variables are available from (node.context().flow).get('varname')
        //      The global variables are available from (node.context().global).get('varname')

        // Set to true if you want additional debug output to the console
        const debug = RED.settings.uibuilder.debug || true

        var prevNodeStatus = {}
        var nodeStatus = {}

        const ioNamespace = '/' + node.url
        
        // Name of the fs path used to hold custom files & folders for all instances of uibuilder
        const customAppFolder = path.join(RED.settings.userDir, 'uibuilder')
        // Name of the fs path used to hold custom files & folders for THIS INSTANCE of uibuilder
        //   Files in this folder are also served to URL but take preference
        //   over those in the nodes folders (which act as defaults)
        const customFolder = path.join(customAppFolder, node.url)
        
        // We need an http server to serve the page
        const app = RED.httpNode || RED.httpAdmin

        // Use httNodeMiddleware function which is defined in settings.js
        // as for the http in/out nodes
        var httpMiddleware = function(req,res,next) { next() }
        if (RED.settings.httpNodeMiddleware) {
            if ( typeof RED.settings.httpNodeMiddleware === 'function' ) {
                httpMiddleware = RED.settings.httpNodeMiddleware
            }
        }
        
        // This ExpressJS middleware runs when the vueui page loads - we'll use it at some point
        // maybe to pass a "room" name in custom header for IO to use
        // so that we can have multiple pages served
        // @see https://expressjs.com/en/guide/using-middleware.html
        function localMiddleware (req, res, next) {
            // Tell the client what namespace to use
            res.setHeader('x-uibuilder-namespace', node.url)
            res.cookie('uibuilder-namespace', node.url, {path: node.url, sameSite: true})
            next()
        }

        // ---- Add custom folder structure if requested ---- //
        if ( node.customFoldersReqd ) {
            // NOTE: May be better as async calls?
            // Make sure the global custom folder exists first
            try {
                fs.mkdirSync(customAppFolder)
                fs.accessSync( customAppFolder, fs.constants.W_OK )
            } catch (e) {
                if ( e.code !== 'EEXIST' ) {
                    debug && RED.log.error('UIBUILDER - uibuilder custom folder ERROR, path: ' + path.join(RED.settings.userDir, customAppFolder) + ', error: ' + e.message)
                }
            }
            // Then make sure the folder for this node instance exists
            try {
                fs.mkdirSync(customFolder)
                fs.accessSync(customFolder, fs.constants.W_OK)
            } catch (e) {
                if ( e.code !== 'EEXIST' ) {
                    debug && RED.log.error('UIBUILDER - uibuilder local custom folder ERROR: ' + e.message)
                }
            }
            // Then make sure the DIST & SRC folders for this node instance exist
            try {
                fs.mkdirSync( path.join(customFolder, 'dist') )
                fs.mkdirSync( path.join(customFolder, 'src') )
                fs.accessSync(customFolder, fs.constants.W_OK)
            } catch (e) {
                if ( e.code !== 'EEXIST' ) {
                    debug && RED.log.error('UIBUILDER - uibuilder local custom dist or src folder ERROR: ' + e.message)
                }
            }
            // Add static path for local custom files
            fs.stat(path.join(customFolder, 'dist', 'index.html'), function(err, stat) {
                if (!err) {
                    // If the ./dist/index.html exists use the dist folder... 
                    app.use( urlJoin(node.url), serveStatic( path.join(customFolder, 'dist') ) );
                } else {
                    // ... otherwise, use dev resources at ./src/
                    debug && RED.log.audit({ 'UIbuilder': node.url+' Using local development folder' });
                    app.use( urlJoin(node.url), serveStatic( path.join(customFolder, 'src') ) );
                    // Include vendor resource source paths if needed
                    node.userVendorPackages.forEach(function (packageName) {
                        //debug && RED.log.audit({ 'UIbuilder': 'Adding vendor paths', 'url':  join(node.url, 'vendor', packageName), 'path': path.join(__dirname, 'node_modules', packageName)});
                        app.use( urlJoin(node.url, 'vendor', packageName), serveStatic(path.join(__dirname, '..', '..', packageName)) );
                    })
                }
            })
        }
        // -------------------------------------------------- //
        
        // Create a new, additional static http path to enable
        // loading of central static resources for uibuilder
        if (useCompiledCode) {
            // If the ./dist/index.html exists use the dist folder... 
            app.use( urlJoin(node.url), httpMiddleware, localMiddleware, serveStatic( path.join( __dirname, 'dist' ) ) );
        } else {
            // ... otherwise, use dev resources at ./src/
            debug && RED.log.audit({ 'UIbuilder': node.url+' Using development folder' });
            app.use( urlJoin(node.url), httpMiddleware, localMiddleware, serveStatic( path.join( __dirname, 'src' ) ) );
            // Include vendor resource source paths if needed
            vendorPackages.forEach(function (packageName) {
                //debug && RED.log.audit({ 'UIbuilder': 'Adding vendor paths', 'url':  urlJoin(node.url, 'vendor', packageName), 'path': path.join(__dirname, '..', 'node_modules', packageName)});
                app.use( urlJoin(node.url, 'vendor', packageName), serveStatic(path.join(__dirname, '..', 'node_modules', packageName)) );
            })
        }

        const fullPath = urlJoin( RED.settings.httpNodeRoot, node.url );
        if ( node.customFoldersReqd ) {
            RED.log.info('UI Builder - Version ' + nodeVersion + ' started at ' + fullPath)
            RED.log.info('UI Builder - Local file overrides at ' + customFolder)
        } else {
            RED.log.info('UI Builder - Version ' + nodeVersion + ' started at ' + fullPath)
            RED.log.info('UI Builder - Local file overrides not requested')
        }

        // Start Socket.IO with a namespace to match the url path, ensure using Socket.IO version from this uibuilder module (using path)
        io = socketio.listen(RED.server, {'path': urlJoin(node.url, 'socket.io')}) // listen === attach
        io.set('transports', ['polling', 'websocket'])
        node.ioClientsCount = 0
        prevNodeStatus = nodeStatus
        nodeStatus = { fill: 'blue', shape: 'dot', text: 'Socket Created' }
        node.status(nodeStatus)
        // Check that all incoming SocketIO data has the IO cookie
        // TODO: Needs a bit more work to add some real security
        io.use(function(socket, next){
            if (socket.request.headers.cookie) {
                node.debug && RED.log.info('SOCKET OK')
                return next()
            }
            next(new Error('UIbuilder:NodeGo:io.use - Authentication error'))
        });

        var ioNs = io.of(ioNamespace)

        // When someone loads the page, it will try to connect over Socket.IO
        // note that the connection returns the socket instance to monitor for responses from 
        // the ui client instance
        ioNs.on('connection', function(socket) {
            node.ioClientsCount++
            RED.log.audit({ 
                'UIbuilder': node.url+' Socket connected', 'clientCount': node.ioClientsCount, 
                'ID': socket.id, 'Cookie': socket.handshake.headers.cookie
            })
            prevNodeStatus = nodeStatus
            nodeStatus = { fill: 'green', shape: 'dot', text: 'connected '+node.ioClientsCount }
            node.status(nodeStatus)
            //console.log('--socket.request.connection.remoteAddress--')
            //console.dir(socket.request.connection.remoteAddress)
            //console.log('--socket.handshake.address--')
            //console.dir(socket.handshake.address)
            //console.dir(io.sockets.connected)

            // Let the clients know we are connecting
            io.of(node.url).emit( ioChannels.control, { 'type': 'connected' } )

            // if the client sends a specific msg channel...
            socket.on(ioChannels.client, function(msg) {
                RED.log.audit({ 
                    'UIbuilder': node.url+' Data recieved from client', 'ID': socket.id, 
                    'Cookie': socket.handshake.headers.cookie, 'data': msg 
                })

                switch ( typeof msg ) {
                    case 'string':
                    case 'number':
                    case 'boolean':
                        msg = { 'topic': node.topic, 'payload': msg}
                }
                // Add sending client id to msg
                msg._socketId = socket.id
                // Send out the message for downstream flows
                // TODO: This should probably have safety validations!
                node.send(msg)
            });

            socket.on('disconnect', function(reason) {
                node.ioClientsCount--
                RED.log.audit({
                    'UIbuilder': node.url+' Socket disconnected', 'clientCount': node.ioClientsCount,
                    'reason': reason, 'ID': socket.id, 'Cookie': socket.handshake.headers.cookie
                })
                prevNodeStatus = nodeStatus
                nodeStatus = { fill: 'green', shape: 'ring', text: 'connected '+node.ioClientsCount }
                node.status(nodeStatus)
            })

            socket.on('error', function(data) {
                RED.log.audit({ 
                    'UIbuilder': node.url+' ERROR recieved', 'ID': socket.id, 
                    'data': data 
                })                
            })

            socket.on('connect', function(data) {
                RED.log.audit({ 
                    'UIbuilder': node.url+' CONNECT recieved', 'ID': socket.id, 
                    'data': data 
                })                
            })
            socket.on('disconnecting', function(data) {
                RED.log.audit({ 
                    'UIbuilder': node.url+' DISCONNECTING recieved', 'ID': socket.id, 
                    'data': data 
                })                
            })
            socket.on('newListener', function(data) {
                RED.log.audit({ 
                    'UIbuilder': node.url+' NEWLISTENER recieved', 'ID': socket.id, 
                    'data': data 
                })                
            })
            socket.on('removeListener', function(data) {
                RED.log.audit({ 
                    'UIbuilder': node.url+' REMOVELISTENER recieved', 'ID': socket.id, 
                    'data': data 
                })                
            })
            socket.on('ping', function(data) {
                RED.log.audit({ 
                    'UIbuilder': node.url+' PING recieved', 'ID': socket.id, 
                    'data': data 
                })                
            })
            socket.on('pong', function(data) {
                RED.log.audit({ 
                    'UIbuilder': node.url+' PONG recieved', 'ID': socket.id, 
                    'data': data 
                })                
            })

        }) // ---- End of ioNs.on connection ---- //

        // handler function for node input events (when a node instance receives a msg)
        function nodeInputHandler(msg) {
            debug && RED.log.info('UIbuilder:nodeGo:nodeInputHandler - emit received msg - Namespace: ' + node.url) //debug

            // Make sure that msg is an object & not null
            if ( msg === null ) {
                msg = {}
            } else if ( typeof msg !== 'object' ) {
                msg = { 'payload': msg }
            }

            // Add topic from node config if present and not present in msg
            if ( !('topic' in msg) && node.topic !== '' ) {
                msg.topic = node.topic
            }
            
            // pass the complete msg object to the vue ui client
            // TODO: This should probably have some safety validation on it
            ioNs.emit(ioChannels.server, msg)

        } // -- end of msg recieved processing -- //
        node.on('input', nodeInputHandler)

        // Do something when Node-RED is closing down
        // which includes when this node instance is redeployed
        node.on('close', function() {
            //debug && RED.log.info('VUEUI:nodeGo:on-close') //debug

            // Let the clients know we are closing down
            io.of(node.url).emit( ioChannels.control, { 'type': 'shutdown' } )

            prevNodeStatus = nodeStatus
            nodeStatus = {}
            node.status(nodeStatus)

            node.removeListener('input', nodeInputHandler)

            // Disconnect all Socket.IO clients
            // WARNING: TODO: If we do this, a client cannot reconnect after redeployment
            //                so the user has to reload the page
            //  They have to do this at the moment anyway so might as well.
            const myNamespace = ioNs // Get Namespace
            const connectedNameSpaceSockets = Object.keys(ioNs.connected) // Get Object with Connected SocketIds as properties
            if ( connectedNameSpaceSockets.length >0 ) {
                connectedNameSpaceSockets.forEach(socketId => {
                    ioNs.connected[socketId].disconnect() // Disconnect Each socket
                })
            }
            ioNs.removeAllListeners() // Remove all Listeners for the event emitter
            delete io.nsps[ioNamespace] // Remove from the server namespaces
            io = null

            // We need to remove the app.use paths too. This code borrowed from the http nodes
            app._router.stack.forEach(function(route,i,routes) {
                if ( route.route && route.route.path === node.url ) {
                    routes.splice(i,1)
                }
            });

        })

    } // ---- End of nodeGo (initialised node instance) ---- //

    // Register the node by name. This must be called before overriding any of the
    // Node functions.
    RED.nodes.registerType(moduleName, nodeGo);
}

// ========== UTILITY FUNCTIONS ================ //

//from: http://stackoverflow.com/a/28592528/3016654
function urlJoin() {
    const trimRegex = new RegExp('^\\/|\\/$','g');
    var paths = Array.prototype.slice.call(arguments);
    return '/'+paths.map(function(e){return e.replace(trimRegex,'');}).filter(function(e){return e;}).join('/');
}

// EOF
