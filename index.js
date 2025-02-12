const express = require("express");
const geoip = require("fast-geoip");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const SellingPartnerAPI = require("amazon-sp-api");
const path = require("path");
const cloudinary = require("cloudinary").v2;
const multer = require("multer");

const app = express();
app.use(express.json());
require("dotenv").config();

const cors = require("cors");
const allowedOrigins = [
  "https://studykey-gifts.vercel.app",
  "http://localhost:3000",
];

const nodemailer = require("nodemailer");
const createDOMPurify = require("dompurify");
const { JSDOM } = require("jsdom");
const window = new JSDOM("").window;
const DOMPurify = createDOMPurify(window);

const mongoose = require("mongoose");

// MongoDB connection optimization
let cachedConnection = null;

async function connectToDatabase() {
  if (cachedConnection) {
    return cachedConnection;
  }

  mongoose.connection.on("connected", () => console.log("MongoDB connected"));
  mongoose.connection.on("error", (err) =>
    console.error("MongoDB connection error:", err)
  );

  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 10000,
      maxPoolSize: 10,
    });

    cachedConnection = conn;
    return conn;
  } catch (error) {
    console.error("MongoDB connection error:", error);
    throw error;
  }
}

const Schema = mongoose.Schema;

const OrderSchema = new Schema({
  name: String,
  language: String,
  email: { type: String, required: true },
  orderId: { type: String, unique: true },
  createdAt: { type: Date, default: Date.now },
  reviewImage: String,
});

let Order;
if (mongoose.models.Order) {
  Order = mongoose.model("Order");
} else {
  Order = mongoose.model("Order", OrderSchema);
}

const handlebars = require("nodemailer-express-handlebars");

// Create a transporter object using the default SMTP transport
let transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER, // Your Gmail address
    pass: process.env.GMAIL_PASS, // Your Gmail password or App Password
  },
});

transporter.use(
  "compile",
  handlebars({
    viewEngine: {
      extName: ".html", // handlebars extension
      partialsDir: path.join(__dirname, "views/email"),
      layoutsDir: path.join(__dirname, "views/email"),
      defaultLayout: "reward.html", // email template file
    },
    viewPath: path.join(__dirname, "views/email"),
    extName: ".html",
  })
);

// Enable various security headers
app.use(helmet());

// Limit requests to 100 per hour per IP
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 100, // limit each IP to 100 requests per windowMs
});

// Apply rate limiter to all requests
app.use(limiter);

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) === -1) {
        var msg =
          "The CORS policy for this site does not allow access from the specified Origin.";
        return callback(new Error(msg), false);
      }
      return callback(null, true);
    },
  })
);

let sellingPartner = new SellingPartnerAPI({
  region: "na", // The region of the selling partner API endpoint ("eu", "na" or "fe")
  refresh_token: process.env.REFRESH_TOKEN, // The refresh token of your app user
  options: {
    credentials: {
      SELLING_PARTNER_APP_CLIENT_ID: process.env.SELLING_PARTNER_APP_CLIENT_ID,
      SELLING_PARTNER_APP_CLIENT_SECRET:
        process.env.SELLING_PARTNER_APP_CLIENT_SECRET,
    },
  },
});

app.post("/validate-order-id", async (req, res) => {
  const { orderId } = req.body;
  try {
    const order = await sellingPartner.callAPI({
      operation: "getOrder",
      endpoint: "orders",
      path: {
        orderId: orderId,
      },
    });

    if (Object.keys(order).length > 0) {
      // Get the order items
      const orderItems = await sellingPartner.callAPI({
        operation: "getOrderItems",
        endpoint: "orders",
        path: {
          orderId: orderId,
        },
      });

      // Extract the ASINs from the order items
      const asins = orderItems.OrderItems.map((item) => item.ASIN);

      res.status(200).send({ valid: true, asins: asins });
    } else {
      res.status(400).send({ valid: false });
    }
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .send({ error: "An error occurred while validating the order ID" });
  }
});

// Configure multer for image uploads only
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit for images
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  }
});

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Helper function to upload image to Cloudinary
async function uploadToCloudinary(file) {
  const b64 = Buffer.from(file.buffer).toString('base64');
  const dataURI = `data:${file.mimetype};base64,${b64}`;
  
  return await cloudinary.uploader.upload(dataURI, {
    folder: 'review-images',
    resource_type: 'image',
    public_id: `review-${Date.now()}`
  });
}

app.post("/submit-review", upload.single("image"), async (req, res) => {
  const formData = req.body;

  if (formData) {
    try {
      await connectToDatabase();

      // Handle image upload if present
      let imageUrl = null;
      if (req.file) {
        const result = await uploadToCloudinary(req.file);
        imageUrl = result.secure_url;
      }

      const order = new Order({
        ...formData,
        reviewImage: imageUrl,
      });

      await order.save();

      // Update admin email to include image
      let adminMailOptions = {
        from: process.env.GMAIL_USER,
        to: process.env.GMAIL_USER,
        subject: "New Soul Delight Claimed",
        html: DOMPurify.sanitize(`
          <h1>New Order Submission</h1>
          ${Object.entries(formData)
            .map(([key, value]) => `<p><strong>${key}:</strong> ${value}</p>`)
            .join("")}
          ${imageUrl ? `<p><strong>Review Image:</strong> <a href="${imageUrl}">View Image</a></p>` : ""}
        `),
      };

      await new Promise((resolve, reject) => {
        transporter.sendMail(adminMailOptions, (error, info) => {
          if (error) {
            console.error("Error sending email to user:", error);
            reject(error);
          } else {
            console.log("Email sent to user:", info);
            resolve(info);
          }
        });
      });

      res.status(200).json({
        success: true,
        message: "Submission successful",
        imageUrl: imageUrl,
      });
    } catch (err) {
      console.error('Upload error:', err);
      if (err.code === 11000 && err.keyPattern && err.keyPattern.orderId) {
        return res.status(409).json({
          success: false,
          message: "Error: Duplicate Claim",
          errorCode: "DUPLICATE_CLAIM",
        });
      }
      res.status(500).json({ 
        success: false, 
        message: err.message.includes('file size') 
          ? "File size too large. Please upload a smaller file."
          : "Error: " + err.message 
      });
    }
  } else {
    res.status(400).json({ success: false, message: "Invalid form data" });
  }
});

app.get("/", async (req, res) => {
  res.status(200).send("api running");
});

app.get("/api/location", async (req, res) => {
  const ip = req.ip || "127.0.0.1";
  const geo = await geoip.lookup(ip);
  res.send(geo);
});

app.listen(5000, function (err) {
  if (err) console.log("Error in server setup");
  console.log("Server listening on Port", 5000);
});

module.exports = app;