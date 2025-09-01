const express = require("express");
const app = express();

// Middleware to parse JSON body
app.use(express.json());

app.get("/test", (req,res) => {
  console.log("Received GET");
  res.send("Server OK");
});

app.post("/", (req, res) => {
  console.log("Received JSON:", req.body);
  
  // Check if request body exists
  if (!req.body) {
    res.status(400).json({ error: "No data provided" });
    return;
  }
  
  // Check if the request has a specific field
  if (req.body.name) {
    // If name exists, check its length
    if (req.body.name.length > 10) {
      res.json({ 
        ok: true, 
        message: "Name is quite long!",
        name: req.body.name 
      });
    } else {
      res.json({ 
        ok: true, 
        message: "Name is a good length",
        name: req.body.name 
      });
    }
  } else if (req.body.email) {
    // If no name but email exists
    res.json({ 
      ok: true, 
      message: "Email received",
      email: req.body.email 
    });
  } else {
    // If neither name nor email exists
    res.json({ 
      ok: true, 
      message: "Data received but no name or email found",
      data: req.body 
    });
  }
});

app.listen(2000, () => {
  console.log("Server listening on http://localhost:2000");
});

