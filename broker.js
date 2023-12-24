import Aedes from "aedes";
import net from "net";
import dotenv from "dotenv";

dotenv.config();

const aedes = Aedes();
const mqttServer = net.createServer(aedes.handle);

mqttServer.listen(process.env.LOCAL_PORT, function () {
    console.log(`Broker started on port: ${process.env.LOCAL_PORT}`);
});
