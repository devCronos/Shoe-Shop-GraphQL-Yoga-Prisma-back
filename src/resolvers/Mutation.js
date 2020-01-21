const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {randomBytes} = require('crypto');
const {promisify} = require('util');
const {transport, makeANiceEmail} = require('../mail');
const {hasPermission} = require('../utils');
const stripe = require('../stripe');


const mutations = {
    async createItem(parent, args, ctx, info) {
        // check if they are logged in
        if(!ctx.request.userId) throw new Error('You must be logged in to create an item');

        const item = await ctx.db.mutation.createItem({
            data: {
                user: {
                    // This  is how to create a relationship betwen the item and the user
                    connect: {
                        id: ctx.request.userId
                    }
                },
                ...args
            }
        }, info);
        return item;
    },
    updateItem(parent, args, ctx, info) {
        // first take a copy of the updates
        const updates = {...args};
        // remove the ID from the updates
        delete updates.id;
        // run the update method
        return ctx.db.mutation.updateItem({
            data: updates,
            where: {
                id: args.id
            }
        },info)
    },
    async deleteItem(parent, args, ctx, info) {
        const where = {id: args.id};
        // find item
        const item = await ctx.db.query.item({where}, `{id title user{id} }`);
        // check for permission
        const ownsItem = item.user.id === ctx.request.userId;
        const hasPermissions = ctx.request.user.permissions.some(permission=>['ADMIN','ITEMDELETE'].includes(permission));
        if(!ownsItem && !hasPermissions) throw new Error("You don't have permissions");
        // delete
        return ctx.db.mutation.deleteItem({where}, info)
    },
    async signup(parent, args, ctx, info) {
        args.email = args.email.toLowerCase();
        // hash password 1way. bcrypt is async. salt makes it unique
        const password = await bcrypt.hash(args.password, 10);
        // create the user in the db
        const user = await ctx.db.mutation.createUser({
            data: {
                ...args,
                password,
                permissions: { set: ['USER'] }
            }
        },info)
        // create the JWT token
        const token = jwt.sign({ userId: user.id }, process.env.APP_SECRET);
        // set the JWT as a cookie on the response
        ctx.response.cookie('token', token, {
            httpOnly: true,
            maxAge: 1000*60*60*24*365
        });
        // return the user
        return user;
    },
    async signin(parent,{email, password},ctx,info){
        // check if user exists
        const user = await ctx.db.query.user({where: {email}});
        if(!user){
            throw new Error(`No user found for email ${email}`);
        }
        // check password
        const valid = await bcrypt.compare(password, user.password);
        if(!valid){
            throw new Error('Invalid password');
        }
        // generate the JWT token
        const token = jwt.sign({ userId: user.id }, process.env.APP_SECRET);
        // set the cookie with the token
        ctx.response.cookie('token', token, {
            httpOnly: true,
            maxAge: 1000*60*60*24*365
        });
        // return the user
        return user;
    },
    signout(parent, args, ctx, info){
        ctx.response.clearCookie('token');
        return {message: 'Goodbye!'};
    },
    async requestReset(parent, args, ctx, info){
        // check if user is real
        
        const user = await ctx.db.query.user({where: {email: args.email}});
        if(!user) throw new Error(`Noy user found for email ${email}`);
        // set a reset token and expiry
        
        const randomBytesPromisified = promisify(randomBytes);
        const resetToken = (await randomBytesPromisified(20)).toString('hex');
        const resetTokenExpiry = Date.now() + 3600000; // 1h
        const res = await ctx.db.mutation.updateUser({
            where: {email: args.email},
            data: {resetToken, resetTokenExpiry}
        });
        // email the reset token
        const mailRes = await transport.sendMail({
            from: 'cl@b.com',
            to: user.email,
            subject: 'Your password reset token',
            html: makeANiceEmail(`Your password reset token is here \n\n 
            <a href="${process.env.FRONTEND_URL}/reset?resetToken=${resetToken}"> Click here to reset </a>`)
        })

        return {message: 'Thanks!'};
    },
    async resetPassword(parent,args,ctx,info){
        // check password
        if(args.password !== args.confirmPassword) throw new Error("Your passwords don't match");
        // check the token
        // check expiry
        const [user] = await ctx.db.query.users({
            where: {
                resetToken: args.resetToken,
                resetTokenExpiry_gte: Date.now() - 3600000,
            }
        });
        if(!user) throw new Error('This token is either invalid or expired')
        // hash their new password
        const password = await bcrypt.hash(args.password, 10);
        // save the new password and remove the reset fields
        const updatedUser = await ctx.db.mutation.updateUser({
            where: {email: user.email},
            data: {
                password,
                resetToken: null,
                resetTokenExpiry: null
            }
        })
        // generate JWT
        const token = jwt.sign({userId: updatedUser.id},process.env.APP_SECRET);
        // set JWT cookie
        ctx.response.cookie('token', token, {
            httpOnly: true,
            maxAge: 1000*60*60*24*365
        });
        return updatedUser;
        // return new user
    },
    async updatePermissions (parent, args, ctx, info){
        // check logged in
        if(!ctx.request.userId) throw new Error('You must be logged in!');
        // query the current user
        const currentUser = await ctx.db.query.user({
            where: {
                id: ctx.request.userId
            }
        }, info)
        // check for permission to change permissions
        hasPermission(currentUser, ['ADMIN','PERMISSIONUPDATE']);
        // update permissions
        return ctx.db.mutation.updateUser({
            data: {
                permissions: {
                    set: args.permissions
                }
            },
            where: {
                id: args.userId
            }
        },info);
    },
    async addToCart(parent,args,ctx,info){
        // check loggedin
        const userId = ctx.request.userId;
        if(!userId) throw new Error('You must be logged in');
        // query the user's current cart
        const [existingCartItem] = await ctx.db.query.cartItems({
            where:{
                user: {id: userId},
                item: {id: args.id},
            }
        });
        // check if user already has item in cart and ++ if it is
        if(existingCartItem){
            return ctx.db.mutation.updateCartItem({
                where: {id: existingCartItem.id},
                data: {quantity: existingCartItem.quantity + 1}
            },info)
        }
        // create a fresh cartitem if it's not
        return ctx.db.mutation.createCartItem({
            data: {
                user: {
                    connect: {id: userId}
                },
                item: {
                    connect: {id: args.id}
                }
            }
        },info)
    },
    async removeFromCart(parent, args, ctx, info){
        // find cart item
        const cartItem = await ctx.db.query.cartItem({
            where:{
                id: args.id
            }
        }, `{id, user {id}}`);
        if(!cartItem) throw new Error('No cart item found!');
        // check if they own that cart item
        if(cartItem.user.id !== ctx.request.userId) throw new Error('You should not be here. I"m watching you');
        // delete cart item
        return ctx.db.mutation.deleteCartItem({
            where: {id: args.id}
        },info )
    },
    async createOrder(parent, args, ctx, info){
        // query the current user and check login
        const {userId} = ctx.request;
        if(!userId) throw new Error('You must be logged in to complete the order');

        const user = await ctx.db.query.user({where: {id:userId}}, `
        {
            id
            name
            email
            cart {
                id
                quantity
                item {title price id description image largeImage}
            }
        }`)
        // recalculate the total for the price !!!!!!!!!!
        const amount = user.cart.reduce((acum, cartItem)=>acum+cartItem.item.price*cartItem.quantity,0);
        console.log(`will charge ${amount}`);
        // create the stripe charge = turn token into money
        const charge = await stripe.charges.create({
            amount: amount,
            currency: 'USD',
            source: args.token
        })
        // convert the cartItems to orderItems
        const orderItems = user.cart.map(cartItem => {
            const orderItem = {
                ...cartItem.item,
                quantity: cartItem.quantity,
                user: {
                    connect:{id: userId}
                },
            }
            delete orderItem.id;
            return orderItem;
        });
        // create the order
        const order = await ctx.db.mutation.createOrder({
            data: {
                total: charge.amount,
                charge: charge.id,
                items: {create: orderItems},
                user: { connect: {id: userId} }
            }
        })
        // clear the user cart, delete cartItems
        const cartItemIds = user.cart.map(cartItem => cartItem.id);
        await ctx.db.mutation.deleteManyCartItems({ where : {
            id_in: cartItemIds
        }});
        // return the order to the client
        return order;
    }
};

module.exports = mutations;
