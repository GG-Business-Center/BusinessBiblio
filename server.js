const express = require("express");
const path = require("path");
const cors = require("cors");
const bodyParser = require("body-parser");
const axios = require("axios");
const { MongoClient } = require("mongodb");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PAYDUNYA_CHECKOUT_URL = "https://app.paydunya.com/api/v1/checkout-invoice/create";
const PAYDUNYA_API_KEY = process.env.PRIVATE_KEY;
const MASTER_KEY = process.env.MASTER_KEY;
const CALLBACK_URL = process.env.CALLBACK_URL;
const RETURN_URL = process.env.RETURN_URL;
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

const MONGO_URI = process.env.MONGO_URI; // URI de connexion MongoDB Atlas

let db; // La base de données MongoDB

// Middleware pour journaliser les requêtes
app.use((req, res, next) => {
    console.log(`Requête reçue : ${req.method} ${req.url}`);
    next();
});

async function connectDB() {
    try {
        const client = await MongoClient.connect(MONGO_URI);
        const db = client.db("Business");
        console.log("🚀 Connexion à MongoDB réussie");
        return db;
    } catch (error) {
        console.error("❌ Erreur de connexion à MongoDB:", error);
        process.exit(1); // Arrête le serveur en cas d'échec
    }
}

connectDB();

// Route pour afficher la page d'accueil
app.get("/", (req, res) => {
    res.sendFile(__dirname + "/public/index.html");
});

// Route pour initier un paiement via PayDunya Checkout
app.post('/checkout', async (req, res) => {
    console.log("🚀 Envoi de la requête de paiement à PayDunya...");

    const { email, contact, parrain } = req.body;

    if (!process.env.MASTER_KEY || !process.env.PRIVATE_KEY || !process.env.TOKEN) {
        console.error("❌ Erreur: MASTER_KEY, PRIVATE_KEY ou TOKEN manquant.");
        return res.status(500).json({ success: false, message: "Configuration PayDunya incorrecte" });
    }

    const paymentData = {
        invoice: {
            total_amount: 200,  
            currency: "XOF",     
            description: "Inscription Business-Biblio",  
            return_url: RETURN_URL,
            cancel_url: CALLBACK_URL,
        },
        store: {
            name: "Business-Biblio",
        },
        actions: {
            cancel_url: CALLBACK_URL,
        },
        customer: {
            email: email,  
            phone: contact 
        }
    };

    try {
        const response = await axios.post(PAYDUNYA_CHECKOUT_URL, paymentData, {
            headers: {
                "Content-Type": "application/json",
                "PAYDUNYA-MASTER-KEY": process.env.MASTER_KEY,
                "PAYDUNYA-PRIVATE-KEY": process.env.PRIVATE_KEY,
                "PAYDUNYA-TOKEN": process.env.TOKEN
            }
        });

        const result = response.data;

        if (result.response_code === "00") {
            res.json({ success: true, payment_url: result.response_text });
        } else {
            res.json({ success: false, message: result.response_text });
        }
    } catch (error) {
        console.error("❌ Erreur lors de la requête PayDunya:", error);
        res.status(500).json({ success: false, message: "Erreur de connexion à PayDunya" });
    }
});

// Route de callback pour PayDunya
app.post("/callback", async (req, res) => {
    console.log("Callback reçu:", req.body);
    const { status, metadata } = req.body;

    if (status === "completed") {
        const { email, contact, parrain } = metadata;

        try {
            const clientsCollection = db.collection("clients");
            const retraitsCollection = db.collection("retraits");

            // Vérification si le client existe déjà
            const clientExists = await clientsCollection.findOne({ email });
            if (!clientExists) {
                const lienParrainage = `https://businessbiblio.onrender.com/?parrain=${encodeURIComponent(contact)}`;
                const newClient = {
                    email,
                    contact,
                    parrain: parrain || null,
                    lienParrainage,
                    solde: 0
                };

                await clientsCollection.insertOne(newClient);

                // Mise à jour du solde du parrain
                if (parrain) {
                    const parrainClient = await clientsCollection.findOne({ contact: parrain });
                    if (parrainClient) {
                        await clientsCollection.updateOne(
                            { contact: parrain },
                            { $inc: { solde: 500 } }
                        );
                    }
                }
            }

            res.sendStatus(200);
        } catch (error) {
            console.error("❌ Erreur lors du traitement du callback:", error);
            res.sendStatus(500);
        }
    } else {
        res.sendStatus(400);
    }
});

// Route de connexion
app.post("/connexion", async (req, res) => {
    const { email, contact } = req.body;

    const clientsCollection = db.collection("clients");
    const client = await clientsCollection.findOne({ email, contact });

    if (client) {
        res.json({
            success: true,
            solde: client.solde || 0,
            lienParrainage: client.lienParrainage || ""
        });
    } else {
        res.json({ success: false, message: "Identifiants incorrects." });
    }
});

// Route pour gérer les retraits
app.post("/retrait", async (req, res) => {
    const { email, contact, montant } = req.body;

    if (!email || !contact || !montant) {
        return res.status(400).json({ message: "Tous les champs sont requis" });
    }

    const clientsCollection = db.collection("clients");
    const retraitsCollection = db.collection("retraits");

    const utilisateur = await clientsCollection.findOne({ email, contact });
    if (!utilisateur) {
        return res.status(400).json({ message: "Utilisateur introuvable" });
    }

    const soldeDisponible = parseFloat(utilisateur.solde);
    const montantRetrait = parseFloat(montant);

    if (soldeDisponible < montantRetrait) {
        return res.status(400).json({ message: "Solde insuffisant" });
    }

    await clientsCollection.updateOne(
        { email, contact },
        { $inc: { solde: -montantRetrait } }
    );

    const retrait = { email, contact, montant: montantRetrait, date: new Date().toISOString() };
    await retraitsCollection.insertOne(retrait);

    console.log("✅ Retrait enregistré :", { email, contact, montantRetrait });

    res.json({ success: true, message: "Retrait enregistré avec succès", redirect: "connexion.html" });
});

// Middleware pour servir les fichiers statiques depuis le dossier 'livres'
app.use("/livres", express.static(path.join(__dirname, "livres")));

// Démarrer le serveur
app.listen(PORT, () => {
    console.log(`🚀 Serveur en écoute sur le port ${PORT}`);
});
