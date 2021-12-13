"use strict";

const app = require('express')(),
    cors = require('cors'),
    http = require('http').createServer(app),
    io = require('socket.io')(http, {
        cors: {
            origin: "https://localhost:3000",
            methods: ["GET", "POST"],
            credentials: true
        }
    }),
    tChat = require('./TMI_api.js'),
    core = require('./core_api.js'),
    sensitive = require('./secrets/sensitive.js'),
    port = 3001;

// -------------------------------------------------------------------------------------
// GLOBAL VARIABLES

let chatConStatus,
    lobbyLeaveTimer,
    tLeaveTimer,
    dcTimer,
    keyObj = {},
    lobbies = {},
    channelList = new Map(),
    userCount = 0;

// -------------------------------------------------------------------------------------
// STARTER FUNCTIONS

function authMaintainer(cID, sec) {
    let timeout = keyObj.expiration - 300000;
    console.log(`Auth maintainer expired, refreshing in ${(timeout/60000).toFixed(1)} minutes.`);
    setTimeout(async () => {
        let maintKey = await core.authConnector(false, cID, sec);
        keyObj = {
            auth: maintKey.data.access_token,
            expiration: maintKey.data.expires_in
        };
        authMaintainer(cID, sec);
    }, (timeout));
}

(async function () {
    try {
        let key = await core.authConnector(false, sensitive.clientID, sensitive.apiSecret);
        keyObj = {
            auth: key.data.access_token,
            expiration: key.data.expires_in
        };
        ioPath();
        authMaintainer(sensitive.clientID, sensitive.apiSecret);
    } catch (e) {
        console.error(`starter function error: ${e}`);
        return e;
    }
})();

// -------------------------------------------------------------------------------------
// ENDPOINT

http.listen(port, () => {
    console.log(`Listening on HTTP for Socket.IO, port ${port}`);
});

// All the HTML pages above will be hosted by Twitch eventually
// -------------------------------------------------------------------------------------
// SOCKET.IO CONNECTION

function Lobby(channelName) {
    this.userCount = 0;
    this.updateTimer = undefined;
    this.emitter = function (socket) {
        this.updateTimer = setInterval(() => {
            socket.to(channelName).volatile.emit("chart update", tChat.channelDataList[channelName].total);
        }, 2000);
    }
}

function ioPath() {
    console.log('Socket.IO listening');
    io.on("connection", (socket) => {
        let channelName;

        socket.on('channel info', async (id) => { // "36985393"
            console.log(typeof id);
            userCount++;
            console.log(`User connected, usercount: ${userCount}`);

            if (id[0] === '.') {
                channelName = id.substr(1);
            } else {
                let query = channelList.get(id);
                if (query) {
                    channelName = query;
                } else {
                    channelName = await core.nameConnector(false, id, sensitive.clientID, keyObj.auth);
                    channelName = channelName.data.data[0].broadcaster_login;
                    channelList.set(id, channelName);
                }
            }

            socket.join(channelName);

            if (chatConStatus === false || chatConStatus === undefined) {
                await tChat.connect();
                if (tChat.client.readyState() === 'OPEN') {
                    chatConStatus = true;
                } else {
                    socket.emit('TMI Failure');
                    return;
                }
            }

            if (userCount === 1 && dcTimer && dcTimer._destroyed === false) {
                clearTimeout(dcTimer);
                console.log("Disconnect timer cancelled.");
            }

            if (!tChat.channelDataList[channelName]) {
                console.log(`Creating new Twitch ChannelData Object: ${channelName}`);
                tChat.channelDataList[channelName] = new tChat.ChannelData();
                await tChat.join(channelName);
            }

            tChat.channelDataList[channelName].viewCount++;
            //console.log(`User connected, tChat.channelDataList.${channelName}.usercount ${tChat.channelDataList[channelName].viewCount}`);

            if (tChat.channelDataList[channelName]) {
                if (tChat.channelDataList[channelName].viewCount === 1 && tLeaveTimer && tLeaveTimer._destroyed === false) {
                    clearTimeout(tLeaveTimer);
                    console.log("tLeaveTimer timer cancelled.");
                }
            }

            if (!lobbies[channelName]) {
                lobbies[channelName] = new Lobby(channelName);
                lobbies[channelName].emitter(socket);
            }

            lobbies[channelName].userCount++;
            //console.log(`User connected, lobbies.${channelName}.usercount: ${lobbies[channelName].userCount}`);

            if (lobbies[channelName]) {
                if (lobbies[channelName].userCount === 1 && lobbyLeaveTimer && lobbyLeaveTimer._destroyed === false) {
                    clearTimeout(lobbyLeaveTimer);
                    console.log("lobbyLeaveTimer timer cancelled.");
                }
            }
        });

        socket.on('disconnect', () => {
            if (chatConStatus === false || chatConStatus === undefined) {
                userCount--;
                console.log(`User disconnected while TMI is down, usercount: ${userCount}`);
            } else {
                userCount--;
                console.log(`User disconnected, usercount: ${userCount}`);

                lobbies[channelName].userCount--;
                //console.log(`User disconnected, lobbies.${channelName}.userCount: ${lobbies[channelName].userCount}`);

                tChat.channelDataList[channelName].viewCount--;
                //console.log(`User disconnected, channelDataList.${channelName}.viewCount--: ${tChat.channelDataList[channelName].viewCount}`);

                if (lobbies[channelName].userCount <= 0) {
                    lobbyLeaveTimer = setTimeout(() => {
                        console.log(`lobbies: ${channelName} deleted.`);
                        clearInterval(lobbies[channelName].updateTimer);
                        delete lobbies[channelName];
                    }, 5000);
                }

                if (tChat.channelDataList[channelName].viewCount <= 0) {
                    tLeaveTimer = setTimeout(() => {
                        tChat.leave(channelName);
                    }, 5000);
                }

                if (userCount <= 0) {
                    dcTimer = setTimeout(async () => {
                        await tChat.disconnect();
                        chatConStatus = false;
                    }, 6000);
                }
            }
        });
    });
}