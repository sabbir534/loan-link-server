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

    // --- 6. USER ROUTES ---

    // Create/Update User
    app.post("/users", async (req, res) => {
      try {
        const user = req.body;

        // Safety Check: Ensure email exists
        if (!user.email) {
          return res.status(400).send({ message: "Email is required" });
        }

        const query = { email: user.email };
        const existingUser = await usersCollection.findOne(query);

        if (existingUser) {
          return res.send({ message: "User already exists", insertedId: null });
        }

        const result = await usersCollection.insertOne({
          name: user.name || "Anonymous", // Fallback if name is missing
          email: user.email,
          photoURL: user.photoURL || "",
          role: user.role || "borrower",
          status: "active",
          timestamp: new Date(),
        });
        res.send(result);
      } catch (error) {
        console.error("Error in POST /users:", error); // Logs error to Server Terminal
        res
          .status(500)
          .send({ message: "Internal Server Error", error: error.message });
      }
    });

    // Get Current User Info & Role
    app.get("/users/me/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      if (req.user.email !== email)
        return res.status(403).send({ message: "Forbidden" });

      const query = { email: email };
      const result = await usersCollection.findOne(query);
      res.send(result);
    });
    // ADMIN: Get All Users (With Search)
    app.get("/users/admin/all", verifyToken, verifyAdmin, async (req, res) => {
      const { search } = req.query;
      let query = {};
      if (search) {
        query = {
          $or: [
            { name: { $regex: search, $options: "i" } },
            { email: { $regex: search, $options: "i" } },
          ],
        };
      }
      const result = await usersCollection.find(query).toArray();
      res.send(result);
    });
    // ADMIN: Update User Role/Status
    app.patch(
      "/users/admin/update/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const { role, status } = req.body;
        const filter = { _id: new ObjectId(id) };

        let updateDoc = { $set: {} };
        if (role) updateDoc.$set.role = role;
        if (status) updateDoc.$set.status = status;

        const result = await usersCollection.updateOne(filter, updateDoc);
        res.send(result);
      }
    );
    // PUBLIC: Get All Loans (Search, Filter, Pagination)
    app.get("/loans", async (req, res) => {
      const { category, search, page = 0, limit = 10 } = req.query;

      let query = {};
      if (category) query.category = category;
      if (search) query.title = { $regex: search, $options: "i" };

      const skip = parseInt(page) * parseInt(limit);

      const result = await loansCollection
        .find(query)
        .skip(skip)
        .limit(parseInt(limit))
        .toArray();

      // Also return total count for pagination
      const total = await loansCollection.countDocuments(query);

      res.send({ loans: result, total });
    });
    // PUBLIC/PRIVATE: Get Single Loan
    app.get("/loans/:id", verifyToken, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await loansCollection.findOne(query);
      res.send(result);
    });

    // MANAGER: Add New Loan
    app.post("/loans", verifyToken, verifyManager, async (req, res) => {
      const loanData = req.body;
      // Add timestamp
      loanData.createdAt = new Date();
      const result = await loansCollection.insertOne(loanData);
      res.send(result);
    });

    // MANAGER: Get Loans Added by Him
    app.get(
      "/loans/manager/my-loans",
      verifyToken,
      verifyManager,
      async (req, res) => {
        const email = req.user.email;
        // Ideally you store "addedBy: email" in the loan document
        const query = { addedBy: email };
        const result = await loansCollection.find(query).toArray();
        res.send(result);
      }
    );

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
