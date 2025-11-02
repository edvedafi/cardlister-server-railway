# Cardlister

This project is a script-based frontend for listing cards. Its overall goal is to take cards from a set of image files and process them into a set of sports cards listings as follows:

1. Split image files into one file per card that came from the image (there could be multiple) or one file per card
2. Match front and back of the cards
3. Identify the set the cards belong to
4. Call the Medusa API to create the products, variants, etc
5. Call the Medusa APIs to add the cards to the inventory