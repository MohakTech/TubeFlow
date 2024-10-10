import { asyncHandler } from "../utils/AsyncHandler";
import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import bcrypt from 'bcryptjs';
import zod from 'zod';
import jwt from "jsonwebtoken"
import { ApiError } from "../utils/ApiError";
import uploadOnCloudinary from "../utils/cloudinary";
import { generateAccessAndRefreshToken } from "../utils/token";
interface TokenInterface {
    userId: string
}
const registrationSchema = zod.object({
    username: zod.string(),
    email: zod.string().email(),
    password: zod.string().min(8),
    fullName: zod.string()
});
const loginSchema = zod.object({
    username: zod.string(),
    email: zod.string().email(),
    password: zod.string().min(8),
});
const passwordSchema = zod.object({
    oldPassword: zod.string(),
    newPassword: zod.string()
})
const updateUsernameSchema = zod.object({
    username: zod.string()
})
const options = {
    httpOnly: true,
    secure: true
}
const prisma = new PrismaClient();

const registerHandler = asyncHandler(async (req: Request, res: Response) => {
    if (!req.body) {
        return res.status(400).json({ message: "Request body is required." });
    }
    
    const files = req.files as { [fieldname: string]: Express.Multer.File[] };
    const avatarPath = files.avatar[0].path;
    const coverImagePath = files.coverImage[0].path || "NULL";
    const { success, data} = registrationSchema.safeParse(req.body);
    if (!success) {
        return res.status(400).json({
            success,
             // Optional: return validation errors
        });
    }

    const existingUser = await prisma.user.findUnique({
        where: {
            username: data.username,
            email: data.email
            
        },
    });

    if (existingUser) {
        throw new ApiError(409, "User already exists");
    }
    const hashedPassword: string = await bcrypt.hash(data.password, 10);
    const avatar = await uploadOnCloudinary(avatarPath);
    console.log(avatar)
    const coverImage = await uploadOnCloudinary(coverImagePath);
    if(!avatar){
        throw new ApiError(409, "Avatar not found")
    }
    const result = await prisma.user.create({
        data:{
            username: data.username,
            email: data.email,
            password: hashedPassword,
            avatar: avatar,
            coverImage: coverImage || "",
            fullName: data.fullName,
            refreshToken: ""
        }
    })

    if(result){
        res.json({
            message: "User Created Successfully",
            result
        })
    }
});

const loginHandler = asyncHandler(async(req: Request, res: Response)=>{
    const {success, data} = loginSchema.safeParse(req.body);
    if(!success){
        throw new ApiError(400, "Bad Request")
    }
    const {username, password, email} = data;
    const user = await prisma.user.findUnique({
        where:{
            username, email
        }
    }) 
    if(!user){
        throw new ApiError(404, "User not found");
    }
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if(!isPasswordValid){
        throw new ApiError(401, "Invalid Password");
    }
    const {accessToken, refreshToken} = await generateAccessAndRefreshToken(user.id);

    res.status(200).cookie("accessToken", accessToken, options)
    .cookie("refreshToken", refreshToken, options)
    .json({
        message: "Successfully Logged In",
        user,
        accessToken,
        refreshToken
    })
})

const logoutHandler = asyncHandler(async(req, res)=>{
    const userId = req.userId
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, refreshToken: true },
    });

    if (!user) {
        throw new ApiError(404, "User not found");
    }

    // 2. Clear the refresh token only if it exists (optimization)
    if (user.refreshToken) {
        await prisma.user.update({
            where: { id: userId },
            data: {
                refreshToken: "",  // Remove the refresh token
            },
        });
    }
    
    res.status(200).clearCookie("accessToken", options)
    .clearCookie("refreshToken", options)
    .json({
        message: "Successfully Logged out",
    })
})

const refreshAccessToken = asyncHandler(async(req, res)=>{
    const incomingRefreshToken = req.cookies.refreshToken || req.body.refreshToken;
    console.log(incomingRefreshToken)
    const refreshTokenSecret = process.env.REFRESH_TOKEN_SECRET;
    console.log(refreshTokenSecret)
    if(!refreshTokenSecret){
        return
    }
    if(!incomingRefreshToken){
        throw new ApiError(401, "Bad Request");
    }
    try {
        const decodedToken = jwt.verify(incomingRefreshToken, refreshTokenSecret);
        if(!decodedToken){
            throw new ApiError(401, "Invalid Refresh Token");
        }
        const user = await prisma.user.findUnique({
            where:{id:(decodedToken as TokenInterface).userId},
            select:{id:true, refreshToken:true}
        })
        if(!user){
            throw new ApiError(404, "User not found")
        }
        if(incomingRefreshToken!==user.refreshToken){
            throw new ApiError(401,"Refresh Token expired")
        }
        const {accessToken, refreshToken} = await generateAccessAndRefreshToken(user.id);
        res.status(200)
        .cookie("accessToken", accessToken, options)
        .cookie("refreshToken", refreshToken, options)
        .json({
            message: "Access token refreshed"
        })
    } catch (error: any) {
        throw new ApiError(400, error)
    }
})

const updatePassword = asyncHandler(async(req, res)=>{
    const {success, data} = passwordSchema.safeParse(req.body)
    if(!success){
        throw new ApiError(401, "Wrong Input")
    }
    const {oldPassword, newPassword} = data
    const userId = req.userId;
    const userDetails = await prisma.user.findUnique({
        where:{
            id:userId
        },
        select:{
            password: true
        }
    }) 
    const retrivedPassword = userDetails?.password;
    if(!retrivedPassword) return;
    const isPasswordValid = await bcrypt.compare(oldPassword, retrivedPassword)
    if(!isPasswordValid){
        throw new ApiError(400, "Unauthorized")
    }
    const hashedNewPassword = await bcrypt.hash(newPassword, 10);
    const result = await prisma.user.update({
        where:{
            id: userId
        },
        data: {
            password: hashedNewPassword
        }
    })
    if(!result) return "Something Went wrong";
    res.status(200).json({
        message: "Password Updated Successfully"
    })
})

const getCurrentUser = asyncHandler(async(req, res)=>{
    const userId = req.userId;
    const result = await prisma.user.findUnique({
        where:{
            id: userId
        },
    })
    if(!result) throw new ApiError(404, "Not Found")
    res.status(200).json({
        user: result
    })
})

const updateUsername = asyncHandler(async(req, res)=>{
    const {success, data} = updateUsernameSchema.safeParse(req.body)
    if(!success){
        throw new ApiError(400, "Bad Request")
    }
    const userId = req.userId;
    const result = await prisma.user.update({
        where:{
            id: userId
        },
        data:{
            username: data?.username
        }
    })
    if(!result) throw new ApiError(401, "Unauthorized")
    res.json({
        message: "Username Updated Sucessfully"
    })
})

const updateUserAvatar = asyncHandler(async(req, res)=>{
    const file = req.file;
    // console.log(file)
    const avatarPath = file?.path
    if(!avatarPath) throw new ApiError(404, "File Not Found")
    const result = await uploadOnCloudinary(avatarPath)
    if(!result) return "Something Went Wrong"
    const databaseUpdate = await prisma.user.update({
        where:{
            id: req.userId
        },
        data:{
            avatar: result
        }
    })
    if(!databaseUpdate) throw new ApiError(404, "Upload Database Failed")
    res.json({
        message: "Avatar Updated"
    })
})

const updateUserCoverImage = asyncHandler(async(req, res)=>{
    const file = req.file;
    // console.log(file)
    const coverImagePath = file?.path
    if(!coverImagePath) throw new ApiError(404, "File Not Found")
    const result = await uploadOnCloudinary(coverImagePath)
    if(!result) return "Something Went Wrong"
    const databaseUpdate = await prisma.user.update({
        where:{
            id: req.userId
        },
        data:{
            coverImage: result
        }
    })
    if(!databaseUpdate) throw new ApiError(404, "Upload Database Failed")
    res.json({
        message: "Cover Image Updated"
    })
})

export { registerHandler, loginHandler, logoutHandler, refreshAccessToken, updatePassword, getCurrentUser,updateUsername,updateUserAvatar, updateUserCoverImage};