const aedes = require("aedes")();
const mqttServer = require("net").createServer(aedes.handle);
require("dotenv").config();

mqttServer.listen(process.env.LOCAL_PORT, function () {
    console.log(`Broker started on port: ${process.env.LOCAL_PORT}`);
});
