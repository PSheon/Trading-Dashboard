import { ApiProperty } from "@nestjs/swagger";
import { IsIn, Matches } from "class-validator";

export class PrepareExecutionWalletDto {
  @ApiProperty({ type: String, enum: ["testnet", "mainnet"], description: "Must equal the deployment's wallet network" })
  @IsIn(["testnet", "mainnet"]) declare network: "testnet" | "mainnet";
}
export class CopyWalletIdDto {
  @ApiProperty({ type: String, pattern: "^[A-Za-z0-9_-]{1,128}$" })
  @Matches(/^[A-Za-z0-9_-]{1,128}$/) declare id: string;
}
