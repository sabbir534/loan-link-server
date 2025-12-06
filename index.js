require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const admin = require("firebase-admin");

const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
const port = process.env.PORT || 5000;

app.use(
  cors({
    // Replace with your frontend URL in production (e.g., https://loanlink.web.app)
    origin: ["http://localhost:5173"],
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

const uri = `mongodb+srv://${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@cluster0.kqlaxvo.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect to MongoDB
    await client.connect();

    const db = client.db("loanLinkDB");
    const usersCollection = db.collection("users");
    const loansCollection = db.collection("loans");
    const applicationsCollection = db.collection("applications");

    // A. Verify Token (Firebase Admin)
    const verifyToken = async (req, res, next) => {
      const token = req.cookies?.token;
      if (!token) {
        return res
          .status(401)
          .send({ message: "Unauthorized access: No token" });
      }
      try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.user = decodedToken;
        next();
      } catch (error) {
        return res
          .status(401)
          .send({ message: "Unauthorized access: Invalid token" });
      }
    };

    // B. Verify Admin Role
    const verifyAdmin = async (req, res, next) => {
      const email = req.user.email;
      const query = { email: email };
      const user = await usersCollection.findOne(query);
      const isAdmin = user?.role === "admin";
      if (!isAdmin) {
        return res
          .status(403)
          .send({ message: "Forbidden access: Admins only" });
      }
      next();
    };

    // C. Verify Manager Role
    const verifyManager = async (req, res, next) => {
      const email = req.user.email;
      const query = { email: email };
      const user = await usersCollection.findOne(query);
      const isManager = user?.role === "manager";
      // Allow Admin to access Manager routes as well if needed, otherwise strict check
      if (!isManager && user?.role !== "admin") {
        return res
          .status(403)
          .send({ message: "Forbidden access: Managers only" });
      }
      next();
    };

    // --- 5. AUTHENTICATION ROUTES ---

    // Login: Verify Firebase token and set HTTP-only cookie
    app.post("/auth/login", async (req, res) => {
      const { token } = req.body;
      try {
        // Verify again for security
        await admin.auth().verifyIdToken(token);

        // Set cookie (Max age: 1 hour)
        res
          .cookie("token", token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
            maxAge: 3600000,
          })
          .send({ success: true });
      } catch (error) {
        res.status(401).send({ message: "Unauthorized" });
      }
    });

    // Logout: Clear cookie
    app.post("/auth/logout", (req, res) => {
      res
        .clearCookie("token", {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
        })
        .send({ success: true });
    });

    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("LoanLink Server is Running");
});

app.listen(port, () => {
  console.log(`LoanLink Server is running on port: ${port}`);
});
