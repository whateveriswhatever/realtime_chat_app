const express = require("express");
const { createServer } = require("node:http");
const { Server } = require("socket.io");
const { join } = require("node:path");
const sqlite3 = require("sqlite3");
const { open } = require("sqlite");
const { availableParallelism } = require("node:os");
const cluster = require("node:cluster");
const { createAdapter, setupPrimary } = require("@socket.io/cluster-adapter");
const { v4: uuidv4 } = require("uuid");
const { connected } = require("node:process");

const hostname = "127.0.0.1";

// const port = 3000;

const app = express();

const server = createServer(app);

const connectedUsers = {};

if (cluster.isPrimary) {
  const numCPUs = availableParallelism();

  // erect one worker per available core
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork({
      PORT: 3000 + i,
    });
  }

  // set up the adapter on the primary thread
  return setupPrimary;
}

const io = new Server(server, {
  connectionStateRecovery: {},

  // set up the adapter on each worker thread
  adapter: createAdapter(),
});

async function main() {
  // open the database file

  const database = await open({
    filename: "chat.db",
    driver: sqlite3.Database,
  });

  // create our "messages" table (we can ignore the "client_offset" column for now)

  await database.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_offset TEXT UNIQUE,
      content TEXT
    );
  `);

  app.get("/", (req, res) => {
    res.sendFile(join(__dirname, "index.html"));
  });

  // const server = http.createServer((req, res) => {
  //   res.status = 200;
  //   res.setHeader("Content-Type", "text/plain");
  // });

  io.on("connection", async (socket) => {
    // console.log("A user connected...");
    // Assign a user ID to the connected client
    const userID = generateUserId();

    // Store the WebSocket connection and user ID mapping
    connectedUsers[socket.id] = userID;

    // Send user ID back to the client
    socket.emit("user_id", userID);

    console.log(`${userID} connected`);

    socket.on("chat message", async (message, clientOffset, callback) => {
      const userID = connectedUsers[socket.id];
      console.log(`${userID} sent a message : ${message}`);

      let result;

      try {
        // store the message in the database
        result = await database.run(
          "INSERT INTO messages (content, client_offset) VALUES (?, ?)",
          message,
          clientOffset
        );
      } catch (err) {
        console.log(err);

        if (err.errno === 19) {
          // sqlite constraint
          // the message was already inserted, so we notify the client
          callback;
        } else {
          // nothing to do, merely let the client retry
        }
        return;
      }
      // include the offset with the message
      io.emit("chat message", message, result.lastID);

      // acknowledge the event
      callback;
    });

    if (!socket.recovered) {
      // if the connection state recovery wasn't successful

      try {
        await database.each(
          "SELECT id, content FROM messages WHERE id > ?",
          [socket.handshake.auth.serverOffset || 0],
          (_err, row) => {
            socket.emit("chat message", row.content, row.id);
          }
        );
      } catch (err) {
        console.log(`Failed to recover the socket >>>> ${err.message}`);
      }
    }

    socket.on("disconnect", () => {
      // console.log("A user disconnected!");
      console.log(`${userID} disconnected!`);
    });
  });

  const port = process.env.PORT;

  server.listen(port, hostname, () => {
    console.log(`Server is running at http://${hostname}:${port}/`);
  });
}

// app.get("/", (req, res) => {
//   res.sendFile(join(__dirname, "index.html"));
// });

// // const server = http.createServer((req, res) => {
// //   res.status = 200;
// //   res.setHeader("Content-Type", "text/plain");
// // });

// io.on("connection", (socket) => {
//   console.log("A user connected...");

//   socket.on("chat message", async (message) => {
//     console.log(`message : ${message}`);

//     let result;

//     try {
//       // store the message in the database
//       result = await database.run
//     } catch (err) {
//       console.log(err);
//       return;
//     }

//     io.emit("chat message", message);
//   });

//   socket.on("disconnect", () => {
//     console.log("A user disconnected!");
//   });
// });

// server.listen(port, hostname, () => {
//   console.log(`Server is running at http://${hostname}:${port}/`);
// });

main();

const generateUserId = () => {
  const uniquelyGeneratedUserId = uuidv4();
  return uniquelyGeneratedUserId;
};
