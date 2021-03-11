const expect = require('chai').expect;
const Websocket = require('ws');
const { HcAppWebSocket, HcAdminWebSocket } = require('../../build/websocket-wrappers/holochain');

let TEST_WS_SERVER
before(async () => {
    TEST_WS_SERVER = new Websocket.Server({ host: "localhost", port: 62831 });
    await new Promise((resolve, reject) => TEST_WS_SERVER.once("listening", resolve));
})

after(() => {
    TEST_WS_SERVER.close();
})

testWs(HcAppWebSocket, "app websocket");
testWs(HcAdminWebSocket, "admin websocket");

function testWs(WsClass, name) {
    describe(name, () => {
        it("resolves opened immediately if already open", async () => {
            const ws = new WsClass("ws://localhost:62831");
            await ws.opened();
            expect(ws.client.socket.readyState).to.equal(Websocket.OPEN);
            await ws.opened();
            ws.close();
        })
        
        it("resolves closed immediately if already closed", async () => {
            const ws = new WsClass("ws://localhost:62831");
            await ws.opened();
            await ws.close();
            expect(ws.client.socket.readyState).to.equal(Websocket.CLOSED);
            await ws.closed();
        })

        it("can be closed before being opened", async () => {
            const ws = new WsClass("ws://localhost:62831");
            expect(ws.client.socket.readyState).to.equal(Websocket.CONNECTING);
            await ws.close();
            expect(ws.client.socket.readyState).to.equal(Websocket.CONNECTING);
        })
    })
}
