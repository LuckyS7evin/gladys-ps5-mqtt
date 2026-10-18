# PS5 Remote Play

Pilotez votre PlayStation 5 depuis Gladys : allumage, mise en mode repos, état
de la console et jeu en cours, avec des déclencheurs de scène et un widget de
tableau de bord. L'intégration reprend le fonctionnement de l'add-on Home
Assistant [ps5-mqtt](https://github.com/FunkeyFlo/ps5-mqtt), sans MQTT :
elle parle directement à la console avec le protocole Remote Play de Sony
(via [playactor](https://github.com/dhleong/playactor)).

Les PlayStation 4 sont aussi prises en charge (allumage, mode repos, jeu en
cours) si vous activez l'option dédiée.

## Préparer la console

Dans les paramètres de la PS5 :

1. **Système > Lecture à distance** : activez **Activer la Lecture à
   distance**.
2. **Système > Économie d'énergie > Fonctions disponibles en mode repos** :
   activez **Rester connecté à Internet** et **Autoriser l'allumage de la
   PS5 depuis le réseau**.
3. La console doit être sur le même réseau local que Gladys (ou joignable
   depuis Gladys, voir _Adresses IP des consoles_).

Sans ces réglages, la console ne répond pas en mode repos ou refuse les
commandes (erreur 403 dans les logs).

## Ajouter la console

1. Allumez la console (pas en mode repos).
2. Ouvrez l'onglet **Découverte** de l'intégration : Gladys recherche les
   consoles sur le réseau local. Ajoutez la vôtre.
3. Si elle n'apparaît pas (autre VLAN, routeur qui filtre les broadcasts),
   saisissez son adresse IP dans **Adresses IP des consoles** (plusieurs
   adresses séparées par des virgules), enregistrez et relancez la
   découverte.

Chaque console devient un appareil avec trois fonctionnalités :

| Fonctionnalité | Valeurs                                                |
| -------------- | ------------------------------------------------------ |
| Power          | 1 = allumée, 0 = mode repos ou injoignable (pilotable) |
| Status         | `playing`, `idle`, `standby` ou `offline`              |
| Game           | nom du jeu en cours, `-` sinon                         |

L'état est relu toutes les 10 secondes.

## Associer la console

Pour allumer ou mettre en veille la console, l'intégration doit être associée
à la console, comme l'application PS Remote Play. Cela se fait une seule fois,
avec les deux actions de l'onglet **Configuration** :

1. Cliquez sur **1. Obtenir le lien de connexion PlayStation**. Ouvrez le lien
   affiché, connectez-vous avec le compte PlayStation utilisé sur la console.
   Vous arrivez sur une page blanche (ou une page d'erreur) : **copiez son
   adresse complète** depuis la barre d'adresse du navigateur. Elle commence
   par `https://remoteplay.dl.playstation.net/remoteplay/redirect?code=`.
2. Sur la console allumée, ouvrez **Paramètres > Système > Lecture à
   distance > Associer un appareil** : un code à 8 chiffres s'affiche.
3. Cliquez sur **2. Associer une console**, choisissez la console, collez
   l'adresse copiée et saisissez le code PIN. Le message sous le bouton
   confirme l'association.

L'adresse copiée n'est valable que quelques minutes : en cas d'échec,
recommencez depuis l'étape 1 avec un nouveau code PIN.

Si votre profil PlayStation demande un code d'accès à la connexion,
renseignez-le dans **Code d'accès du profil** (chiffres, ou noms de touches
séparés par des espaces, par exemple `up up down down`).

## Jeu en cours (facultatif)

La PS5 n'indique pas ce qu'elle exécute. Le jeu en cours est lu dans la
présence de votre compte PlayStation Network, avec un jeton **NPSSO** :

1. Connectez-vous sur [playstation.com](https://www.playstation.com/).
2. Dans le même navigateur, ouvrez
   <https://ca.account.sony.com/api/v1/ssocookie>. La page affiche
   `{"npsso":"…"}` : copiez la valeur de 64 caractères.
3. Collez-la dans **Jeton NPSSO** et enregistrez.
4. Cliquez sur **Tester le compte PlayStation Network** pour vérifier.

Le jeton NPSSO expire au bout de deux mois, mais il ne sert qu'à la première
connexion : l'intégration conserve et renouvelle ensuite ses propres jetons
(dans son volume `/data`, lisibles par elle seule). Si la connexion échoue,
l'écran de configuration l'indique : générez un nouveau jeton NPSSO.

Le jeu est attribué à la console allumée correspondant à la plateforme du jeu.
Si plusieurs consoles sont allumées, choisissez la **Console préférée**.
L'**Intervalle de rafraîchissement du jeu** (30 s par défaut, 10 s minimum)
respecte la limite de l'API de Sony (300 requêtes par 15 minutes).

Sur PS4, le jeu en cours est fourni par la console elle-même, sans compte PSN.

## Scènes

- Utilisez la fonctionnalité **Power** de la console dans les actions
  « Contrôler un appareil » pour allumer ou mettre en veille la console, et
  dans les déclencheurs « Changement d'état d'un appareil » pour réagir à son
  allumage.
- **Jeu lancé** (déclencheur) : un jeu démarre sur une console. Filtrez
  éventuellement sur la console et l'identifiant du titre (par exemple
  `PPSA01521_00`). Les actions suivantes peuvent lire
  `{{triggerEvent.data.title_name}}` et `{{triggerEvent.data.title_id}}`.
- **Jeu arrêté** (déclencheur) : le jeu est fermé, la console est mise en
  veille ou n'est plus joignable.

Exemple : « quand un jeu est lancé sur la PS5 du salon, baisser les lumières
et allumer la barre de son ».

## Tableau de bord

Ajoutez le widget **PlayStation** et choisissez une console : il affiche
l'alimentation en direct, l'état, le jeu en cours avec sa jaquette, et deux
boutons **Allumer** et **Mode repos**.

## Dépannage

- **La console n'apparaît pas dans la Découverte** : vérifiez qu'elle est
  allumée ou en mode repos avec **Rester connecté à Internet**, puis saisissez
  son adresse IP dans la configuration.
- **« not paired yet »** : faites l'association (actions 1 et 2).
- **Erreur 403** : la Lecture à distance est désactivée sur la console, ou
  l'association a été supprimée : associez à nouveau la console.
- **« passcode »** : renseignez le code d'accès du profil.
- **L'état reste `offline`** : la console est éteinte complètement (pas en
  mode repos) ou a changé d'adresse IP ; l'intégration relance une recherche
  au plus toutes les 5 minutes.
- Les logs de l'intégration (page Supervision de Gladys) donnent le détail
  de chaque erreur.
