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

const MONGO_URI = process.env.MONGO_URI;

let db;
let mongoClient;

async function connectDB() {
    try {
        mongoClient = new MongoClient(MONGO_URI);
        await mongoClient.connect();
        db = mongoClient.db("Business");
        console.log("🚀 Connexion à MongoDB réussie");
        return db;
    } catch (error) {
        console.error("❌ Erreur de connexion à MongoDB:", error);
        process.exit(1);
    }
}

process.on("SIGINT", async () => {
    console.log("🛑 Fermeture du serveur...");
    await mongoClient.close();
    process.exit(0);
});

app.get("/inscription", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "inscription.html"));
});

app.get("/", (req, res) => {
    res.sendFile(__dirname + "/public/index.html");
});

app.post('/checkout', async (req, res) => {
    console.log("🚀 Envoi de la requête de paiement à PayDunya...");

    const { nomComplet, contact, email, parrain } = req.body;

    if (!process.env.MASTER_KEY || !process.env.PRIVATE_KEY || !process.env.TOKEN) {
        console.error("❌ Erreur: MASTER_KEY, PRIVATE_KEY ou TOKEN manquant.");
        return res.status(500).json({ success: false, message: "Configuration PayDunya incorrecte" });
    }

    console.log("Nom complet :", nomComplet);
    console.log("Numéro de téléphone :", contact);
    console.log("email :", email);

    try {
        const clientsCollection = db.collection("clients");
        const existingClient = await clientsCollection.findOne({ email });

        if (!existingClient) {
            const lienParrainage = `https://businessbiblio.onrender.com/?parrain=${encodeURIComponent(contact)}`;
            const newClient = {
                nomComplet,
                email,
                contact,
                parrain: parrain || null,
                lienParrainage,
                solde: 0,
                statut: "en attente"
            };
            await clientsCollection.insertOne(newClient);
        }

        const paymentData = {
            invoice: {
                total_amount: 200,
                currency: "XOF",
                description: "Inscription Business-Biblio"
            },
            store: {
                name: "Business-Biblio"
            },
            actions: {
                return_url: RETURN_URL,
                cancel_url: CALLBACK_URL,
                callback_url: CALLBACK_URL
            },
            customer: {
                name: nomComplet,
                phone_number: contact,
                email: email
            },
            metadata: {
                email,
                contact,
                parrain: parrain || null
            }
        };

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

app.post("/callback", async (req, res) => {
    console.log("🔥 Callback PayDunya reçu !");
    console.log("🧾 Données complètes reçues :", JSON.stringify(req.body, null, 2));

    const { status, metadata } = req.body;

    if (status === "completed") {
        const { email, contact, parrain } = metadata || {};
        
        console.log("📧 Email:", email);
        console.log("📱 Contact:", contact);
        console.log("🤝 Parrain:", parrain);

        try {
            const clientsCollection = db.collection("clients");

            await clientsCollection.updateOne(
                { email },
                { $set: { statut: "actif" } }
            );

            if (parrain) {
                await clientsCollection.updateOne(
                    { contact: parrain },
                    { $inc: { solde: 500 } }
                );
            }

            res.sendStatus(200);
        } catch (error) {
            console.error("❌ Erreur lors du traitement du callback:", error);
            res.sendStatus(500);
        }
    } else {
        console.warn("⚠️ Callback reçu avec un statut NON complété :", status);
        res.sendStatus(400);
    }
});



app.post("/connexion", async (req, res) => {
    const { email, contact } = req.body;

    try {
        const clientsCollection = db.collection("clients");
        const client = await clientsCollection.findOne({ email, contact });

        if (!client) {
            return res.status(404).json({ success: false, message: "Aucun client trouvé avec ces informations." });
        }

        if (client.statut !== "actif") {
            return res.status(403).json({ success: false, message: "Votre inscription n'est pas encore validée." });
        }

        // ✅ Réponse JSON avec les infos du client
        res.json({
            success: true,
            solde: client.solde,
            lienParrainage: client.lienParrainage,
            client: {
                email: client.email,
                contact: client.contact,
                statutClient: client.statut
            }
        });

    } catch (error) {
        console.error("Erreur lors de la tentative de connexion:", error);
        res.status(500).json({ success: false, message: "Erreur serveur. Veuillez réessayer plus tard." });
    }
});


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

    const retrait = { email, contact, montant: montantRetrait, statut: "en attente", date: new Date().toISOString() };
    await retraitsCollection.insertOne(retrait);

    console.log("✅ Retrait enregistré :", { email, contact, montantRetrait });

    res.json({ success: true, message: "Retrait enregistré avec succès", redirect: "connexion.html" });
});

app.use("/livres", express.static(path.join(__dirname, "livres")));

app.post("/historique", async (req, res) => {
    const { email, contact } = req.body;

    if (!email || !contact) {
        return res.status(400).json({ success: false, message: "Email et contact requis" });
    }

    try {
        const clientsCollection = db.collection("clients");
        const retraitsCollection = db.collection("retraits");

        const filleuls = await clientsCollection
            .find({ parrain: contact })
            .project({ email: 1, contact: 1, _id: 0 })
            .toArray();

        const retraits = await retraitsCollection
            .find({ email, contact })
            .project({ montant: 1, statut: 1, _id: 0 })
            .toArray();

        res.json({ success: true, filleuls, retraits });

    } catch (error) {
        console.error("❌ Erreur lors de la récupération de l'historique:", error);
        res.status(500).json({ success: false, message: "Erreur serveur" });
    }
});


connectDB().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Serveur en écoute sur le port ${PORT}`);
    });
});
